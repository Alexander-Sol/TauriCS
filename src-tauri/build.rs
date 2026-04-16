use std::env;
use std::fs;
use std::path::{Path, PathBuf};
/**
 * @file This is the main build script for the Rust core of the Tauri application.
 * It runs before the Rust code is compiled and is responsible for preparing the C# backend.
 * Its tasks include:
 * 1. Compiling all C# source projects into Native AOT DLLs.
 * 2. Copying the compiled DLLs to a root "staging" directory (`natives/`).
 * 3. Synchronizing the staging directory with the final `src-tauri/natives` directory,
 * which will be bundled with the final application.
 */
use std::process::Command;

/// <summary>
/// A helper function to compile a single C# project using .NET Native AOT.
/// It calls `dotnet publish` with the specified configuration and Runtime Identifier (RID).
/// </summary>
/// <param name="project_path">The path to the C# project directory.</param>
/// <param name="config">The build configuration ("Debug" or "Release").</param>
/// <param name="rid">The .NET Runtime Identifier (e.g., "win-x64").</param>
fn publish_native_aot_native(project_path: &Path, config: &str, rid: &str) {
    // Tell Cargo to re-run this script if the C# project directory changes.
    println!("cargo:rerun-if-changed={}", project_path.to_str().unwrap());
    let status = Command::new("dotnet")
        .arg("publish")
        .arg(project_path)
        .arg("-c")
        .arg(config)
        .arg("-r")
        .arg(rid)
        .status()
        .expect("Failed to execute .NET publish for Native AOT native");

    if !status.success() {
        panic!("Failed to publish Native AOT native: {:?}", project_path);
    }
}

fn publish_dotnet_tool(project_path: &Path, config: &str, rid: &str) {
    println!("cargo:rerun-if-changed={}", project_path.to_str().unwrap());
    let status = Command::new("dotnet")
        .arg("publish")
        .arg(project_path)
        .arg("-c")
        .arg(config)
        .arg("-r")
        .arg(rid)
        .status()
        .expect("Failed to execute .NET publish for tool");

    if !status.success() {
        panic!("Failed to publish .NET tool: {:?}", project_path);
    }
}

/// <summary>
/// The main entry point of the build script.
/// </summary>
fn main() {
    // Determine if this is a debug or release build.
    let profile = env::var("PROFILE").unwrap();
    let config = if profile == "release" {
        "Release"
    } else {
        "Debug"
    };
    let csharp_root = PathBuf::from("../src-csharp");
    // Determine the .NET Runtime Identifier based on the current build target.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap();
    let target_arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
    let target_rid = match (target_os.as_str(), target_arch.as_str()) {
        ("windows", "x86_64") => "win-x64",
        ("windows", "aarch64") => "win-arm64",
        ("macos", "x86_64") => "osx-x64",
        ("macos", "aarch64") => "osx-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        (os, arch) => panic!("Unsupported platform: {}-{}", os, arch),
    };
    // .NET Native AOT produces platform-specific library extensions.
    let native_ext = match target_os.as_str() {
        "windows" => "dll",
        "macos" => "dylib",
        _ => "so",
    };

    // --- Stage 1: Build all C# projects from source ---

    // First, build the shared 'Globals' library as it's a dependency for others.
    let abs_path = csharp_root.join("Globals");
    let _ = Command::new("dotnet")
        .arg("build")
        .arg(&abs_path)
        .arg("-c")
        .arg(config)
        .status();

    // Find and publish all individual native library projects located in `src-csharp/Native`.
    let native_src_dir = csharp_root.join("Native");
    if let Ok(entries) = fs::read_dir(&native_src_dir) {
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                publish_native_aot_native(&entry.path(), config, target_rid);
            }
        }
    }

    let tools_src_dir = csharp_root.join("Tools");
    if let Ok(entries) = fs::read_dir(&tools_src_dir) {
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().map_or(false, |ft| ft.is_dir()) {
                publish_dotnet_tool(&entry.path(), config, target_rid);
            }
        }
    }

    // --- Stage 2: Copy build artifacts to a root "staging" directory ---
    // This directory (`natives/` in the project root) allows developers to manually add
    // pre-compiled DLLs that will also be included in the final bundle.
    let root_natives_staging_dir = PathBuf::from("../natives");
    if !root_natives_staging_dir.exists() {
        fs::create_dir_all(&root_natives_staging_dir).unwrap();
    }

    // Copy the newly published DLLs from their build output folders to the staging directory.
    if let Ok(entries) = fs::read_dir(&native_src_dir) {
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
                continue;
            }
            let native_name = entry.file_name().into_string().unwrap();

            // Dynamically find the .NET framework version (e.g., "net9.0") to make the script more robust.
            let framework_scan_path = entry.path().join("bin").join(config);
            let dotnet_framework = fs::read_dir(framework_scan_path)
                .ok()
                .and_then(|d| {
                    d.filter_map(Result::ok)
                        .map(|e| e.file_name().into_string().unwrap())
                        .filter(|n| n.starts_with("net"))
                        .max()
                })
                .unwrap_or_else(|| "net9.0".to_string());

            let published_dll_path = entry
                .path()
                .join("bin")
                .join(config)
                .join(&dotnet_framework)
                .join(target_rid)
                .join("publish")
                .join(format!("{}.{}", native_name, native_ext));
            if published_dll_path.exists() {
                fs::copy(
                    &published_dll_path,
                    root_natives_staging_dir.join(format!("{}.{}", native_name, native_ext)),
                )
                .unwrap();
            }
        }
    }

    if let Ok(entries) = fs::read_dir(&tools_src_dir) {
        for entry in entries.filter_map(Result::ok) {
            if !entry.file_type().map_or(false, |ft| ft.is_dir()) {
                continue;
            }

            let tool_name = entry.file_name().into_string().unwrap();
            let framework_scan_path = entry.path().join("bin").join(config);
            let dotnet_framework = fs::read_dir(framework_scan_path)
                .ok()
                .and_then(|d| {
                    d.filter_map(Result::ok)
                        .map(|e| e.file_name().into_string().unwrap())
                        .filter(|n| n.starts_with("net"))
                        .max()
                })
                .unwrap_or_else(|| "net10.0".to_string());

            let tool_file_name = if target_os == "windows" {
                format!("{}.exe", tool_name)
            } else {
                tool_name.clone()
            };

            let published_tool_path = entry
                .path()
                .join("bin")
                .join(config)
                .join(&dotnet_framework)
                .join(target_rid)
                .join("publish")
                .join(&tool_file_name);

            if published_tool_path.exists() {
                fs::copy(
                    &published_tool_path,
                    root_natives_staging_dir.join(&tool_file_name),
                )
                .unwrap();
            }
        }
    }

    // Copy peer managed/native libraries that mzLib looks for on disk at runtime.
    // Native AOT does not emit these sidecar assemblies, but Readers.dll still loads
    // them dynamically based on file type detection, so they must live in natives/.
    let mzlib_peer_files: &[(&str, &[&str])] = &[
        ("Readers.XmlSerializers.dll", &["src-csharp/lib/mzLib/Readers.XmlSerializers.dll"]),
        ("System.Data.SQLite.dll", &[".nuget/packages/stub.system.data.sqlite.core.netstandard/1.0.118/lib/netstandard2.1/System.Data.SQLite.dll"]),
        ("Microsoft.Data.Sqlite.dll", &[".nuget/packages/microsoft.data.sqlite.core/8.0.0/lib/net8.0/Microsoft.Data.Sqlite.dll"]),
        ("SQLitePCLRaw.core.dll", &[".nuget/packages/sqlitepclraw.core/2.1.6/lib/netstandard2.0/SQLitePCLRaw.core.dll"]),
        ("SQLitePCLRaw.provider.e_sqlite3.dll", &[".nuget/packages/sqlitepclraw.provider.e_sqlite3/2.1.6/lib/netstandard2.0/SQLitePCLRaw.provider.e_sqlite3.dll"]),
        ("SQLitePCLRaw.batteries_v2.dll", &[".nuget/packages/sqlitepclraw.bundle_e_sqlite3/2.1.6/lib/netstandard2.0/SQLitePCLRaw.batteries_v2.dll"]),
        ("libe_sqlite3.dylib", &[".nuget/packages/sqlitepclraw.lib.e_sqlite3/2.1.6/runtimes/osx-x64/native/libe_sqlite3.dylib"]),
        ("ThermoFisher.CommonCore.BackgroundSubtraction.dll", &["src-csharp/lib/mzLib/ThermoFisher.CommonCore.BackgroundSubtraction.dll"]),
        ("ThermoFisher.CommonCore.Data.dll", &["src-csharp/lib/mzLib/ThermoFisher.CommonCore.Data.dll"]),
        ("ThermoFisher.CommonCore.MassPrecisionEstimator.dll", &["src-csharp/lib/mzLib/ThermoFisher.CommonCore.MassPrecisionEstimator.dll"]),
        ("ThermoFisher.CommonCore.RawFileReader.dll", &["src-csharp/lib/mzLib/ThermoFisher.CommonCore.RawFileReader.dll"]),
    ];
    let nuget_stub_base = PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    )
    .join("");
    for (file_name, relative_sources) in mzlib_peer_files {
        let dest = root_natives_staging_dir.join(file_name);
        if !dest.exists() {
            for relative_source in *relative_sources {
                let src = nuget_stub_base.join(relative_source);
                if src.exists() {
                    fs::copy(&src, &dest).unwrap_or_default();
                    break;
                }
            }
        }
    }

    // --- Stage 3: Synchronize the staging directory to the final `src-tauri` directory ---
    // This is the final location that Tauri's bundler will look at.
    let src_tauri_natives_dir = PathBuf::from("./natives");
    if !src_tauri_natives_dir.exists() {
        fs::create_dir_all(&src_tauri_natives_dir).unwrap();
    }

    // Clean the destination directory before copying to ensure no old files are left.
    let _ = fs::read_dir(&src_tauri_natives_dir).map(|e| {
        e.for_each(|f| {
            let _ = fs::remove_file(f.unwrap().path());
        })
    });

    // Copy all DLLs from the staging directory to the final `src-tauri/natives` directory.
    if let Ok(entries) = fs::read_dir(&root_natives_staging_dir) {
        for entry in entries.filter_map(Result::ok) {
            let dest_path = src_tauri_natives_dir.join(entry.file_name());
            fs::copy(entry.path(), dest_path).unwrap();
        }
    }

    // Finally, run the standard Tauri build process.
    tauri_build::build();
}
