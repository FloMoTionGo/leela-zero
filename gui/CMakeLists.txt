# Leela Zero desktop GUI for Windows: a WebView2 host (host/main.cpp) that shows
# the HTML interface in ui/ and drives KataGo or Leela Zero over GTP.
# The engines are not built here; see gui/README.md for the package layout.

add_executable(leelaz-gui WIN32 host/main.cpp)
target_include_directories(leelaz-gui PRIVATE webview2)
target_compile_definitions(leelaz-gui PRIVATE UNICODE _UNICODE _WIN32_WINNT=0x0A00 WINVER=0x0A00)

if(MINGW)
    # MinGW links the loader DLL directly; -static avoids shipping the GCC runtime.
    target_link_options(leelaz-gui PRIVATE -municode -static)
    set(WEBVIEW2_LOADER ${CMAKE_CURRENT_SOURCE_DIR}/webview2/WebView2Loader.dll)
else()
    set(WEBVIEW2_LOADER ${CMAKE_CURRENT_SOURCE_DIR}/webview2/WebView2Loader.dll.lib)
endif()
target_link_libraries(leelaz-gui PRIVATE ${WEBVIEW2_LOADER} ole32 shlwapi shell32 comdlg32 dwmapi uuid)

add_custom_command(TARGET leelaz-gui POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
            ${CMAKE_CURRENT_SOURCE_DIR}/webview2/WebView2Loader.dll $<TARGET_FILE_DIR:leelaz-gui>
    COMMAND ${CMAKE_COMMAND} -E copy_directory
            ${CMAKE_CURRENT_SOURCE_DIR}/ui $<TARGET_FILE_DIR:leelaz-gui>/ui)
