// Leela Zero GUI host: a Win32 window with a WebView2 control that shows the
// HTML interface in ui/. The page does all Go logic; the host only starts
// engine processes (GTP over pipes), opens/saves files and stores settings.
//
//   leelaz-gui.exe                     normal start
//   leelaz-gui.exe --selftest out.png  page runs its self test, then posts
//                                      "ready"; the host saves a PNG and exits
//
// Page -> host (string messages, fields separated by \t):
//   hello | start id cwd cmdline | send id line | stop id
//   open-sgf | save-sgf suggested-name content | save-settings json | ready
// Host -> page (JSON):
//   {type:"hello", exeDir, selftest, settings}   settings = saved JSON text or ""
//   {type:"started", id, ok, error} {type:"line", id, stream, text}
//   {type:"exit", id, code} {type:"file", path, content} {type:"saved", path}

#include <windows.h>
#include <commdlg.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <dwmapi.h>

#include <algorithm>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "WebView2.h"

namespace {

const UINT WM_ENGINE_LINE = WM_APP + 1;
const UINT WM_ENGINE_EXIT = WM_APP + 2;

// Minimal COM callback object; MinGW has no WRL.
template <typename I, typename... Args>
class Handler final : public I {
public:
    Handler(REFIID iid, std::function<HRESULT(Args...)> fn) : m_iid(iid), m_fn(std::move(fn)) {}
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&m_ref); }
    ULONG STDMETHODCALLTYPE Release() override {
        const auto ref = InterlockedDecrement(&m_ref);
        if (ref == 0) delete this;
        return ref;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, m_iid)) {
            *out = this;
            AddRef();
            return S_OK;
        }
        *out = nullptr;
        return E_NOINTERFACE;
    }
    HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return m_fn(args...); }

private:
    LONG m_ref = 1;
    IID m_iid;
    std::function<HRESULT(Args...)> m_fn;
};

HWND g_window = nullptr;
ICoreWebView2Controller* g_controller = nullptr;
ICoreWebView2* g_webview = nullptr;
std::wstring g_selftest_png;
std::wstring g_selftest_scenario;  // optional name after the PNG path
int g_selftest_css_w = 1920;       // optional "WxH" page size in CSS pixels after the scenario
int g_selftest_css_h = 1080;
bool g_dark = false;               // the page's light/dark scheme

// ---------------- strings ----------------
std::wstring widen(const std::string& s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
    return w;
}

std::string narrow(const std::wstring& w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

std::wstring json_str(const std::wstring& s) {
    std::wstring out = L"\"";
    for (wchar_t c : s) {
        switch (c) {
        case L'"': out += L"\\\""; break;
        case L'\\': out += L"\\\\"; break;
        case L'\n': out += L"\\n"; break;
        case L'\r': out += L"\\r"; break;
        case L'\t': out += L"\\t"; break;
        default:
            if (c < 0x20) {
                wchar_t buf[8];
                swprintf(buf, 8, L"\\u%04x", c);
                out += buf;
            } else {
                out += c;
            }
        }
    }
    return out + L"\"";
}

std::vector<std::wstring> split_tabs(const std::wstring& s, size_t max_parts) {
    std::vector<std::wstring> parts;
    size_t start = 0;
    while (parts.size() + 1 < max_parts) {
        auto tab = s.find(L'\t', start);
        if (tab == std::wstring::npos) break;
        parts.push_back(s.substr(start, tab - start));
        start = tab + 1;
    }
    parts.push_back(s.substr(start));
    return parts;
}

void post_json(const std::wstring& json) {
    if (g_webview) g_webview->PostWebMessageAsJson(json.c_str());
}

// ---------------- paths and files ----------------
std::wstring exe_dir() {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    PathRemoveFileSpecW(path);
    return path;
}

std::wstring user_data_dir() {
    wchar_t base[MAX_PATH];
    SHGetFolderPathW(nullptr, CSIDL_LOCAL_APPDATA, nullptr, 0, base);
    std::wstring dir = std::wstring(base) + L"\\LeelaZeroGUI";
    CreateDirectoryW(dir.c_str(), nullptr);
    return dir;
}

std::wstring settings_path() { return user_data_dir() + L"\\settings.json"; }

bool read_file(const std::wstring& path, std::string& out) {
    std::ifstream f(path.c_str(), std::ios::binary);
    if (!f) return false;
    std::ostringstream ss;
    ss << f.rdbuf();
    out = ss.str();
    return true;
}

bool write_file(const std::wstring& path, const std::string& data) {
    std::ofstream f(path.c_str(), std::ios::binary | std::ios::trunc);
    f << data;
    return static_cast<bool>(f);
}

// ---------------- engines ----------------
struct LineMsg {
    std::wstring id;
    bool err;
    std::string text;
};

struct Engine {
    std::wstring id;
    HANDLE process = nullptr;
    HANDLE stdin_write = nullptr;
};

std::map<std::wstring, std::unique_ptr<Engine>> g_engines;

void reader_thread(std::wstring id, HANDLE pipe, bool err) {
    std::string pending;
    char buf[4096];
    DWORD n;
    while (ReadFile(pipe, buf, sizeof buf, &n, nullptr) && n > 0) {
        pending.append(buf, n);
        size_t nl;
        while ((nl = pending.find('\n')) != std::string::npos) {
            std::string line = pending.substr(0, nl);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            pending.erase(0, nl + 1);
            PostMessageW(g_window, WM_ENGINE_LINE, 0, (LPARAM) new LineMsg{id, err, line});
        }
    }
    if (!pending.empty()) PostMessageW(g_window, WM_ENGINE_LINE, 0, (LPARAM) new LineMsg{id, err, pending});
    CloseHandle(pipe);
}

void stop_engine(const std::wstring& id) {
    auto it = g_engines.find(id);
    if (it == g_engines.end()) return;
    auto& e = *it->second;
    if (e.stdin_write) {
        DWORD w;
        WriteFile(e.stdin_write, "quit\n", 5, &w, nullptr);
        CloseHandle(e.stdin_write);
        e.stdin_write = nullptr;
    }
    if (WaitForSingleObject(e.process, 3000) == WAIT_TIMEOUT) TerminateProcess(e.process, 1);
}

void start_engine(const std::wstring& id, const std::wstring& cwd, const std::wstring& cmdline) {
    stop_engine(id);
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE in_r, in_w, out_r, out_w, err_r, err_w;
    CreatePipe(&in_r, &in_w, &sa, 0);
    CreatePipe(&out_r, &out_w, &sa, 0);
    CreatePipe(&err_r, &err_w, &sa, 0);
    SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0);

    STARTUPINFOW si{};
    si.cb = sizeof si;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = in_r;
    si.hStdOutput = out_w;
    si.hStdError = err_w;
    PROCESS_INFORMATION pi{};
    std::wstring cmd = cmdline;  // CreateProcessW may modify the buffer
    BOOL ok = CreateProcessW(nullptr, &cmd[0], nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr,
                             cwd.empty() ? nullptr : cwd.c_str(), &si, &pi);
    CloseHandle(in_r);
    CloseHandle(out_w);
    CloseHandle(err_w);
    if (!ok) {
        const DWORD code = GetLastError();
        CloseHandle(in_w);
        CloseHandle(out_r);
        CloseHandle(err_r);
        post_json(L"{\"type\":\"started\",\"id\":" + json_str(id) + L",\"ok\":false,\"error\":" +
                  json_str(L"CreateProcess failed with error " + std::to_wstring(code)) + L"}");
        return;
    }
    CloseHandle(pi.hThread);
    auto engine = std::make_unique<Engine>();
    engine->id = id;
    engine->process = pi.hProcess;
    engine->stdin_write = in_w;
    std::thread(reader_thread, id, out_r, false).detach();
    std::thread(reader_thread, id, err_r, true).detach();
    std::thread([id, process = pi.hProcess] {
        WaitForSingleObject(process, INFINITE);
        DWORD code = 0;
        GetExitCodeProcess(process, &code);
        PostMessageW(g_window, WM_ENGINE_EXIT, code, (LPARAM) new std::wstring(id));
    }).detach();
    g_engines[id] = std::move(engine);
    post_json(L"{\"type\":\"started\",\"id\":" + json_str(id) + L",\"ok\":true}");
}

void send_engine(const std::wstring& id, const std::wstring& line) {
    auto it = g_engines.find(id);
    if (it == g_engines.end() || !it->second->stdin_write) return;
    const std::string data = narrow(line) + "\n";
    DWORD written;
    WriteFile(it->second->stdin_write, data.data(), (DWORD)data.size(), &written, nullptr);
}

// ---------------- dialogs ----------------
void open_sgf() {
    wchar_t path[MAX_PATH] = L"";
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof ofn;
    ofn.hwndOwner = g_window;
    ofn.lpstrFilter = L"SGF game records (*.sgf)\0*.sgf\0All files\0*.*\0";
    ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    std::string content;
    if (!GetOpenFileNameW(&ofn) || !read_file(path, content)) return;
    post_json(L"{\"type\":\"file\",\"path\":" + json_str(path) + L",\"content\":" + json_str(widen(content)) + L"}");
}

void save_sgf(const std::wstring& suggested, const std::wstring& content) {
    wchar_t path[MAX_PATH];
    lstrcpynW(path, suggested.c_str(), MAX_PATH);
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof ofn;
    ofn.hwndOwner = g_window;
    ofn.lpstrFilter = L"SGF game records (*.sgf)\0*.sgf\0";
    ofn.lpstrFile = path;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrDefExt = L"sgf";
    ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
    if (GetSaveFileNameW(&ofn) && write_file(path, narrow(content))) {
        post_json(L"{\"type\":\"saved\",\"path\":" + json_str(path) + L"}");
    }
}

// ---------------- page messages ----------------
// Saves the page as PNG, then quits with exit_code (4 if the capture fails).
void capture_and_exit(int exit_code) {
    IStream* stream = nullptr;
    if (!g_webview || FAILED(SHCreateStreamOnFileEx(g_selftest_png.c_str(), STGM_CREATE | STGM_WRITE,
                                                    FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) {
        PostQuitMessage(3);
        return;
    }
    g_webview->CapturePreview(
        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream,
        new Handler<ICoreWebView2CapturePreviewCompletedHandler, HRESULT>(
            IID_ICoreWebView2CapturePreviewCompletedHandler, [stream, exit_code](HRESULT hr) {
                stream->Release();
                PostQuitMessage(SUCCEEDED(hr) ? exit_code : 4);
                return S_OK;
            }));
}

// Title bar, window background and the WebView's backdrop follow the page's
// scheme, so loading or resizing never flashes the other colour.
void apply_theme(bool dark) {
    g_dark = dark;
    BOOL on = dark;
    DwmSetWindowAttribute(g_window, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &on, sizeof on);
    const COLORREF ground = dark ? RGB(0x2a, 0x28, 0x22) : RGB(0xef, 0xeb, 0xe4);
    const auto old = reinterpret_cast<HBRUSH>(
        SetClassLongPtrW(g_window, GCLP_HBRBACKGROUND, reinterpret_cast<LONG_PTR>(CreateSolidBrush(ground))));
    if (old) DeleteObject(old);
    if (g_controller) {
        ICoreWebView2Controller2* controller2 = nullptr;
        if (SUCCEEDED(g_controller->QueryInterface(IID_ICoreWebView2Controller2, reinterpret_cast<void**>(&controller2)))) {
            COREWEBVIEW2_COLOR color{255, GetRValue(ground), GetGValue(ground), GetBValue(ground)};
            controller2->put_DefaultBackgroundColor(color);
            controller2->Release();
        }
    }
    SetWindowPos(g_window, nullptr, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED);
}

void on_web_message(const std::wstring& msg) {
    const auto p = split_tabs(msg, 4);
    const auto& type = p[0];
    if (type == L"hello") {
        std::string settings;
        read_file(settings_path(), settings);
        post_json(L"{\"type\":\"hello\",\"exeDir\":" + json_str(exe_dir()) +
                  L",\"selftest\":" + (g_selftest_png.empty() ? L"false" : L"true") +
                  L",\"scenario\":" + json_str(g_selftest_scenario) +
                  L",\"settings\":" + json_str(widen(settings)) + L"}");
    } else if (type == L"start" && p.size() == 4) {
        start_engine(p[1], p[2], p[3]);
    } else if (type == L"send" && p.size() >= 3) {
        send_engine(p[1], split_tabs(msg, 3)[2]);
    } else if (type == L"stop" && p.size() >= 2) {
        stop_engine(p[1]);
    } else if (type == L"open-sgf") {
        open_sgf();
    } else if (type == L"save-sgf" && p.size() >= 3) {
        const auto parts = split_tabs(msg, 3);
        save_sgf(parts[1], parts[2]);
    } else if (type == L"save-settings" && p.size() >= 2) {
        write_file(settings_path(), narrow(split_tabs(msg, 2)[1]));
    } else if (type == L"theme" && p.size() >= 2) {
        apply_theme(p[1] == L"dark");
    } else if (type == L"ready" && !g_selftest_png.empty()) {
        capture_and_exit(0);
    }
}

HRESULT on_controller(HRESULT hr, ICoreWebView2Controller* controller) {
    if (FAILED(hr) || !controller) {
        PostQuitMessage(5);
        return S_OK;
    }
    g_controller = controller;
    g_controller->AddRef();
    g_controller->get_CoreWebView2(&g_webview);

    RECT bounds;
    GetClientRect(g_window, &bounds);
    g_controller->put_Bounds(bounds);

    ICoreWebView2_3* webview3 = nullptr;
    if (SUCCEEDED(g_webview->QueryInterface(IID_ICoreWebView2_3, reinterpret_cast<void**>(&webview3)))) {
        const auto ui = exe_dir() + L"\\ui";
        webview3->SetVirtualHostNameToFolderMapping(L"app.local", ui.c_str(),
                                                    COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_ALLOW);
        webview3->Release();
    }

    EventRegistrationToken token;
    g_webview->add_WebMessageReceived(
        new Handler<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*,
                    ICoreWebView2WebMessageReceivedEventArgs*>(
            IID_ICoreWebView2WebMessageReceivedEventHandler,
            [](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) {
                LPWSTR text = nullptr;
                if (SUCCEEDED(args->TryGetWebMessageAsString(&text)) && text) {
                    on_web_message(text);
                    CoTaskMemFree(text);
                }
                return S_OK;
            }),
        &token);

    apply_theme(g_dark);
    g_webview->Navigate(g_dark ? L"https://app.local/index.html?scheme=dark" : L"https://app.local/index.html");
    return S_OK;
}

HRESULT on_environment(HRESULT hr, ICoreWebView2Environment* env) {
    if (FAILED(hr) || !env) {
        MessageBoxW(g_window,
                    L"The Microsoft Edge WebView2 Runtime is required.\n"
                    L"Download it from https://developer.microsoft.com/microsoft-edge/webview2/",
                    L"Leela Zero", MB_ICONERROR);
        PostQuitMessage(6);
        return S_OK;
    }
    return env->CreateCoreWebView2Controller(
        g_window, new Handler<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT,
                              ICoreWebView2Controller*>(
                      IID_ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, on_controller));
}

LRESULT CALLBACK window_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    switch (msg) {
    case WM_ENGINE_LINE: {
        std::unique_ptr<LineMsg> m(reinterpret_cast<LineMsg*>(lp));
        post_json(L"{\"type\":\"line\",\"id\":" + json_str(m->id) + L",\"stream\":" +
                  (m->err ? L"\"err\"" : L"\"out\"") + L",\"text\":" + json_str(widen(m->text)) + L"}");
        return 0;
    }
    case WM_ENGINE_EXIT: {
        std::unique_ptr<std::wstring> id(reinterpret_cast<std::wstring*>(lp));
        auto it = g_engines.find(*id);
        if (it != g_engines.end()) {
            if (it->second->stdin_write) CloseHandle(it->second->stdin_write);
            CloseHandle(it->second->process);
            g_engines.erase(it);
        }
        post_json(L"{\"type\":\"exit\",\"id\":" + json_str(*id) + L",\"code\":" + std::to_wstring(wp) + L"}");
        return 0;
    }
    case WM_GETMINMAXINFO: {
        auto info = reinterpret_cast<MINMAXINFO*>(lp);
        if (g_selftest_png.empty()) {
            // Smallest window the layout is designed for: 1100x640 CSS pixels.
            UINT dpi = GetDpiForWindow(hwnd);
            const double scale = (dpi ? dpi : GetDpiForSystem()) / 96.0;
            info->ptMinTrackSize.x = static_cast<LONG>(1100 * scale);
            info->ptMinTrackSize.y = static_cast<LONG>(640 * scale);
        } else {
            // A self test may be larger than the screen.
            info->ptMaxTrackSize.x = info->ptMaxTrackSize.y = 32000;
        }
        return 0;
    }
    case WM_SIZE:
        if (g_controller) {
            RECT bounds;
            GetClientRect(hwnd, &bounds);
            g_controller->put_Bounds(bounds);
        }
        return 0;
    case WM_TIMER:  // selftest watchdog: keep the page state for diagnosis
        KillTimer(hwnd, 1);
        capture_and_exit(2);
        return 0;
    case WM_CLOSE:
        for (auto& e : g_engines) stop_engine(e.first);
        DestroyWindow(hwnd);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    int argc = 0;
    auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i + 1 < argc; ++i) {
        if (std::wstring(argv[i]) == L"--selftest") {
            g_selftest_png = argv[i + 1];
            if (i + 2 < argc) g_selftest_scenario = argv[i + 2];
            if (i + 3 < argc) swscanf(argv[i + 3], L"%dx%d", &g_selftest_css_w, &g_selftest_css_h);
        }
    }
    LocalFree(argv);

    // Start in the saved scheme (self tests always start light).
    std::string saved_settings;
    if (g_selftest_png.empty() && read_file(settings_path(), saved_settings)) {
        g_dark = saved_settings.find("\"dark\":true") != std::string::npos;
    }

    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    WNDCLASSW wc{};
    wc.lpfnWndProc = window_proc;
    wc.hInstance = instance;
    wc.lpszClassName = L"LeelaZeroGUI";
    wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
    wc.hIcon = LoadIcon(instance, MAKEINTRESOURCE(1));
    wc.hbrBackground = CreateSolidBrush(g_dark ? RGB(0x2a, 0x28, 0x22) : RGB(0xef, 0xeb, 0xe4));
    RegisterClassW(&wc);

    // Sizes are in device pixels. The normal window fills most of the work
    // area; a self test gets an exact page size in CSS pixels (default 1920x1080).
    const UINT dpi = GetDpiForSystem();
    const double scale = dpi / 96.0;
    RECT work;
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
    const int work_w = work.right - work.left, work_h = work.bottom - work.top;
    int w, h;
    if (g_selftest_png.empty()) {
        w = std::min(work_w * 9 / 10, static_cast<int>(1680 * scale));
        h = std::min(work_h * 9 / 10, static_cast<int>(1000 * scale));
    } else {
        RECT client{0, 0, static_cast<LONG>(g_selftest_css_w * scale), static_cast<LONG>(g_selftest_css_h * scale)};
        AdjustWindowRectExForDpi(&client, WS_OVERLAPPEDWINDOW, FALSE, 0, dpi);
        w = client.right - client.left;
        h = client.bottom - client.top;
    }
    const int x = work.left + std::max(0, (work_w - w) / 2);
    const int y = work.top + std::max(0, (work_h - h) / 2);
    g_window = CreateWindowW(wc.lpszClassName, L"Leela Zero", WS_OVERLAPPEDWINDOW, x, y, w, h, nullptr,
                             nullptr, instance, nullptr);
    apply_theme(g_dark);
    ShowWindow(g_window, show);
    if (!g_selftest_png.empty()) SetTimer(g_window, 1, 240000, nullptr);

    const auto data_dir = user_data_dir();
    HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
        nullptr, data_dir.c_str(), nullptr,
        new Handler<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT,
                    ICoreWebView2Environment*>(
            IID_ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, on_environment));
    if (FAILED(hr)) on_environment(hr, nullptr);

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    for (auto& e : g_engines) stop_engine(e.first);
    if (g_webview) g_webview->Release();
    if (g_controller) g_controller->Release();
    CoUninitialize();
    return static_cast<int>(msg.wParam);
}
