fn main() {
    tauri_build::build();
    // Tauri embeds the Common Controls manifest for app binaries; the native
    // quota visual-check example also needs it for Windows TaskDialogIndirect.
    #[cfg(windows)]
    {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
    }
}
