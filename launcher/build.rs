fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let mut res = winresource::WindowsResource::new();
    res.set_icon("icon.ico");
    res.set("ProductName", "DownX");
    res.set("FileDescription", "DownX 终端下载管理器");
    res.set("ProductVersion", env!("CARGO_PKG_VERSION"));
    res.set("FileVersion", env!("CARGO_PKG_VERSION"));
    res.set("OriginalFilename", "downx.exe");
    res.set("LegalCopyright", "MIT OR Apache-2.0");
    if let Err(e) = res.compile() {
        // 没有 rc.exe 等情况下退化为"无图标"，不阻断构建
        println!("cargo:warning=嵌入 Windows 资源失败（{e}），将不带头部图标");
    }
}
