/// Integration tests for the ImspConverter native library.
///
/// These tests load the compiled Native AOT dylib directly via libloading and call its
/// exported `execute` symbol. This exercises the same code path as the running Tauri app,
/// catching issues (like missing peer DLLs) that the C# xUnit tests miss because those
/// run under the regular .NET JIT runtime, not Native AOT.
///
/// Run with: cd src-tauri && cargo test --test imsp_converter_integration
use libloading::{Library, Symbol};
use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::c_char;
use std::path::{Path, PathBuf};

type ExecuteFunc = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type FreeStringFunc = unsafe extern "C" fn(*mut c_char);
type GetNativeNameFunc = unsafe extern "C" fn() -> *mut c_char;

/// The mzML test file. Same path used by the C# xUnit test.
const TEST_MZML: &str = "/Users/alex/Downloads/02-18-20_jurkat_td_rep2_fract7.mzML";

fn natives_dir() -> PathBuf {
    // cargo test runs with CWD = the crate manifest directory (src-tauri/).
    PathBuf::from("./natives")
}

fn dylib_path() -> PathBuf {
    natives_dir().join(format!("ImspConverter.{}", std::env::consts::DLL_EXTENSION))
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/// Load the dylib, call `execute` with the given JSON payload, return the
/// response string. Returns `None` if the dylib doesn't exist (build not run).
fn call_execute(json_payload: &str) -> Option<String> {
    let path = dylib_path();
    if !path.exists() {
        eprintln!("Skipping: ImspConverter dylib not found at {path:?}");
        return None;
    }

    unsafe {
        let lib = Library::new(&path).expect("Failed to load ImspConverter dylib");
        let execute: Symbol<ExecuteFunc> = lib.get(b"execute\0").expect("execute symbol missing");
        let free_string: Symbol<FreeStringFunc> = lib
            .get(b"free_string\0")
            .expect("free_string symbol missing");

        let c_payload = CString::new(json_payload).unwrap();
        let result_ptr = execute(c_payload.as_ptr());

        if result_ptr.is_null() {
            return Some("(null)".to_string());
        }

        let result = CStr::from_ptr(result_ptr).to_string_lossy().into_owned();
        free_string(result_ptr);
        Some(result)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Regression guard: System.Data.SQLite.dll must be present in natives/.
///
/// mzLib's Readers.dll looks for this file on disk (relative to Assembly.Location,
/// which is empty in Native AOT, falling back to the process CWD). The fix is to
/// keep this DLL in natives/ and point CWD there in NativeEntry's static constructor.
/// If this test fails, copy the DLL from:
///   ~/.nuget/packages/stub.system.data.sqlite.core.netstandard/.../netstandard2.1/System.Data.SQLite.dll
#[test]
fn system_data_sqlite_dll_present_in_natives() {
    let dll = natives_dir().join("System.Data.SQLite.dll");
    assert!(
        dll.exists(),
        "System.Data.SQLite.dll is missing from src-tauri/natives/.\n\
         Copy it from the stub NuGet package:\n  \
         cp ~/.nuget/packages/stub.system.data.sqlite.core.netstandard/1.0.118/lib/netstandard2.1/System.Data.SQLite.dll \\\n  \
             natives/"
    );
}

/// Regression guard: plain (non-indexed) mzML files must not fail due to missing
/// XmlSerializer metadata for Readers.Generated.mzMLType under Native AOT.
#[test]
fn plain_mzml_does_not_fail_with_missing_parameterless_constructor() {
    let temp_dir = std::env::temp_dir();
    let mzml_path = temp_dir.join("taurics_plain_mzml_regression.mzML");

    let mzml = r#"<?xml version="1.0" encoding="utf-8"?>
<mzML xmlns="http://psi.hupo.org/ms/mzml" version="1.1.0" id="test">
  <cvList count="0" />
  <fileDescription>
    <fileContent />
  </fileDescription>
  <run id="run1">
    <spectrumList count="0"></spectrumList>
  </run>
</mzML>
"#;

    fs::write(&mzml_path, mzml).expect("failed to write temporary mzML fixture");

    let payload = format!(
        r#"{{"MzmlPath":"{}","OutputPath":null}}"#,
        mzml_path.display()
    );

    let response = match call_execute(&payload) {
        Some(r) => r,
        None => {
            let _ = fs::remove_file(&mzml_path);
            return;
        }
    };

    let _ = fs::remove_file(&mzml_path);

    assert!(
        !response.contains("does not have a parameterless constructor"),
        "Regression: plain mzML deserialization failed because XmlSerializer metadata was not available. Response: {response}"
    );
}

/// Regression guard: the ImspConverter dylib must load and identify itself correctly.
#[test]
fn imsp_converter_dylib_loads_and_reports_name() {
    let path = dylib_path();
    if !path.exists() {
        eprintln!("Skipping: dylib not found");
        return;
    }

    unsafe {
        let lib = Library::new(&path).expect("Failed to load ImspConverter dylib");
        let get_name: Symbol<GetNativeNameFunc> = lib
            .get(b"get_native_name\0")
            .expect("get_native_name symbol missing");
        let free_string: Symbol<FreeStringFunc> = lib
            .get(b"free_string\0")
            .expect("free_string symbol missing");

        let name_ptr = get_name();
        assert!(!name_ptr.is_null());
        let name = CStr::from_ptr(name_ptr).to_string_lossy().into_owned();
        free_string(name_ptr);

        assert_eq!(name, "imspconverter");
    }
}

/// Regression guard: calling execute must NEVER produce the SQLite-not-found error,
/// regardless of whether the security check passes in the test process.
///
/// Acceptable responses: a successful conversion OR a security-check rejection.
/// The one forbidden response is the SQLite assembly-resolution failure that this
/// test was written to catch.
#[test]
fn imsp_converter_execute_does_not_fail_with_sqlite_not_found() {
    if !Path::new(TEST_MZML).exists() {
        eprintln!("Skipping: test mzML not found at {TEST_MZML}");
        return;
    }

    let payload = format!(r#"{{"MzmlPath":"{}","OutputPath":null}}"#, TEST_MZML);

    let response = match call_execute(&payload) {
        Some(r) => r,
        None => return, // dylib not built yet
    };

    assert!(
        !response.contains("Could not find file 'System.Data.SQLite'"),
        "Regression: mzLib could not resolve System.Data.SQLite.dll.\n\
         Ensure natives/System.Data.SQLite.dll exists and that NativeEntry's\n\
         static constructor sets CWD to the natives/ directory.\n\
         Full response: {response}"
    );
}

/// Full end-to-end conversion test. Requires the test process to be named 'taurics'
/// or 'taurics.exe' to pass the security check, so this is primarily useful when run
/// from within the Tauri app. It is skipped silently if the mzML file is absent or
/// if the security check rejects the test runner.
#[test]
fn imsp_converter_converts_mzml_to_imsp_successfully() {
    if !Path::new(TEST_MZML).exists() {
        eprintln!("Skipping: test mzML not found at {TEST_MZML}");
        return;
    }

    let payload = format!(r#"{{"MzmlPath":"{}","OutputPath":null}}"#, TEST_MZML);

    let response = match call_execute(&payload) {
        Some(r) => r,
        None => return,
    };

    // Skip if the security check rejected the test process — that's expected.
    if response.contains("Security check failed") {
        eprintln!(
            "Skipping end-to-end assertion: security check rejected test process (expected)."
        );
        return;
    }

    assert!(
        !response.contains("\"Error\":\"") || response.contains("\"Error\":null"),
        "Conversion failed. Response: {response}"
    );
    assert!(
        response.contains("\"ImspPath\""),
        "No ImspPath in response: {response}"
    );
}
