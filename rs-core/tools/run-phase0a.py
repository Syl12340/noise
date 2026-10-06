#!/usr/bin/env python3
"""
Phase 0A: Independent Build & Verification Orchestrator

Executes Phase 0A staged validation:
  Stage 1: Preflight checks (toolchain, target wasm32v1-none, mandatory Cargo.lock check, Node.js)
  Stage 2: Native host unit tests (`cargo test --locked --offline`)
  Stage 3: WASM binary build (`cargo build --target wasm32v1-none --release --locked --offline -p noise-wasm`)
  Stage 4: Node.js WASM acceptance check (`node phase0a/check-wasm.cjs`)
  Stage 5: Asset & Host Sync (Only executed if Stage 4 passes with exit 0 AND status PASSED)
  Stage 6: WeChat Real-Device status (strictly recorded as UNRUN until operator supplies results)

Constraints:
  - Confined strictly to `rs-core`: all operations are verified to reside within ROOT_DIR
  - Mandatory Cargo.lock check (no fallback to non-locked builds)
  - Subprocess calls use explicit argv list with timeout=60 (no shell=True)
  - Never auto-installs toolchains, targets, or network packages
  - Missing target results in explicit non-zero exit and BLOCKED status
"""

import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
REPORTS_DIR = ROOT_DIR / "reports"
TARGET_DIR = ROOT_DIR / "target"
WECHAT_DIR = ROOT_DIR / "phase0a" / "wechat-probe"
WECHAT_ASSETS_DIR = WECHAT_DIR / "assets"
WASM_BUILD_ARTIFACT = TARGET_DIR / "wasm32v1-none" / "release" / "noise_wasm.wasm"
DEST_WASM_ARTIFACT = WECHAT_ASSETS_DIR / "noise_wasm.wasm"
SRC_HOST_CJS = ROOT_DIR / "phase0a" / "probe-host.cjs"
DEST_HOST_JS = WECHAT_DIR / "probe-host.js"
LOCKFILE = ROOT_DIR / "Cargo.lock"

# Absolute path confinement check
def assert_confined_to_root(path_to_check: Path):
    resolved = path_to_check.resolve()
    try:
        resolved.relative_to(ROOT_DIR)
    except ValueError:
        raise PermissionError(f"Security confinement violation: path {resolved} is outside {ROOT_DIR}")


def run_command(argv, cwd=ROOT_DIR, timeout_sec=60):
    """Executes a command safely with shell=False and strict timeout."""
    assert_confined_to_root(cwd)
    start_time = time.time()
    try:
        proc = subprocess.run(
            argv,
            cwd=str(cwd),
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
        )
        elapsed = time.time() - start_time
        return {
            "cmd": argv,
            "exit_code": proc.returncode,
            "stdout": proc.stdout.strip(),
            "stderr": proc.stderr.strip(),
            "duration_sec": elapsed,
        }
    except subprocess.TimeoutExpired:
        elapsed = time.time() - start_time
        return {
            "cmd": argv,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Command timed out after {timeout_sec} seconds",
            "duration_sec": elapsed,
        }
    except Exception as e:
        elapsed = time.time() - start_time
        return {
            "cmd": argv,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"Subprocess launch error: {str(e)}",
            "duration_sec": elapsed,
        }


def sha256_file(filepath: Path) -> str:
    assert_confined_to_root(filepath)
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def main():
    print("=================================================================")
    print(" Phase 0A: Independent Rust/WASM Probe Verification Runner")
    print(f" Working Directory: {ROOT_DIR}")
    print("=================================================================")

    # Enforce confinement
    assert_confined_to_root(REPORTS_DIR)
    assert_confined_to_root(WECHAT_ASSETS_DIR)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    WECHAT_ASSETS_DIR.mkdir(parents=True, exist_ok=True)

    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "orchestrator": "tools/run-phase0a.py",
        "stages": {},
        "blockers": [],
        "overall_status": "UNKNOWN",
    }

    # -------------------------------------------------------------------------
    # Stage 1: Preflight Toolchain & Target & Mandatory Lockfile Check
    # -------------------------------------------------------------------------
    print("\n[Stage 1/6] Preflight & Toolchain Discovery...")
    preflight = {
        "status": "RUNNING",
        "rustc": None,
        "cargo": None,
        "node": None,
        "target_wasm32v1_none_installed": False,
        "lockfile_present": LOCKFILE.is_file(),
    }

    # Check rustc
    r_rustc = run_command(["rustc", "--version"])
    preflight["rustc"] = r_rustc["stdout"] if r_rustc["exit_code"] == 0 else "NOT_FOUND"

    # Check cargo
    r_cargo = run_command(["cargo", "--version"])
    preflight["cargo"] = r_cargo["stdout"] if r_cargo["exit_code"] == 0 else "NOT_FOUND"

    # Check node
    r_node = run_command(["node", "--version"])
    preflight["node"] = r_node["stdout"] if r_node["exit_code"] == 0 else "NOT_FOUND"

    # Check installed rust targets via rustup
    r_targets = run_command(["rustup", "target", "list", "--installed"])
    installed_targets = []
    if r_targets["exit_code"] == 0:
        installed_targets = [t.strip() for t in r_targets["stdout"].splitlines() if t.strip()]
    else:
        # Fallback to checking rustc sysroot
        r_sysroot = run_command(["rustc", "--print", "sysroot"])
        if r_sysroot["exit_code"] == 0:
            target_lib = Path(r_sysroot["stdout"]) / "lib" / "rustlib"
            if target_lib.is_dir():
                installed_targets = [p.name for p in target_lib.iterdir() if p.is_dir()]

    preflight["installed_targets"] = installed_targets
    has_target = "wasm32v1-none" in installed_targets
    preflight["target_wasm32v1_none_installed"] = has_target

    print(f"  rustc   : {preflight['rustc']}")
    print(f"  cargo   : {preflight['cargo']}")
    print(f"  node    : {preflight['node']}")
    print(f"  target  : wasm32v1-none -> {'INSTALLED' if has_target else 'MISSING'}")
    print(f"  lockfile: {'EXISTS' if preflight['lockfile_present'] else 'MISSING'}")

    # Mandatory Lockfile Rule: no fallback
    if not preflight["lockfile_present"]:
        preflight["status"] = "FAILED"
        report["blockers"].append("Cargo.lock is missing. Offline locked build requires Cargo.lock.")
    elif not has_target:
        report["blockers"].append(
            "Target wasm32v1-none is not installed in the active toolchain. "
            "Per brief constraints, agents cannot auto-install components or access the network. "
            "Operator authorization required: `rustup target add wasm32v1-none`."
        )
        preflight["status"] = "PASSED"
    elif preflight["rustc"] == "NOT_FOUND" or preflight["cargo"] == "NOT_FOUND":
        preflight["status"] = "FAILED"
        report["blockers"].append("Rust toolchain (rustc/cargo) not found in PATH.")
    else:
        preflight["status"] = "PASSED"

    report["stages"]["1_preflight"] = preflight

    # -------------------------------------------------------------------------
    # Stage 2: Native Host Unit Tests (cargo test --locked --offline)
    # -------------------------------------------------------------------------
    print("\n[Stage 2/6] Native Unit Tests (cargo test --locked --offline)...")
    if preflight["status"] != "PASSED":
        stage2 = {"status": "SKIPPED", "reason": "Preflight checks failed."}
        print("  Result: SKIPPED (preflight failed)")
    else:
        cargo_test_cmd = ["cargo", "test", "--locked", "--offline"]
        r_test = run_command(cargo_test_cmd)
        stage2 = {
            "status": "PASSED" if r_test["exit_code"] == 0 else "FAILED",
            "cmd": r_test["cmd"],
            "exit_code": r_test["exit_code"],
            "duration_sec": r_test["duration_sec"],
            "stdout": r_test["stdout"],
            "stderr": r_test["stderr"],
        }
        if r_test["exit_code"] == 0:
            print(f"  Result: PASSED ({r_test['duration_sec']:.2f}s)")
        else:
            print(f"  Result: FAILED (exit {r_test['exit_code']})")
            report["blockers"].append(f"Native unit tests failed: {r_test['stderr'][:200]}")

    report["stages"]["2_native_tests"] = stage2

    # -------------------------------------------------------------------------
    # Stage 3: WASM Binary Build (target: wasm32v1-none)
    # -------------------------------------------------------------------------
    print("\n[Stage 3/6] WebAssembly Build (target: wasm32v1-none)...")
    if not has_target:
        stage3 = {
            "status": "UNRUN",
            "reason": "Missing target wasm32v1-none. Build blocked until target is installed.",
        }
        print("  Result: UNRUN (target wasm32v1-none missing)")
    elif stage2.get("status") != "PASSED":
        stage3 = {
            "status": "SKIPPED",
            "reason": "Native unit tests did not pass.",
        }
        print("  Result: SKIPPED (Stage 2 not passed)")
    else:
        cargo_build_cmd = [
            "cargo",
            "build",
            "--target",
            "wasm32v1-none",
            "--release",
            "--locked",
            "--offline",
            "-p",
            "noise-wasm",
        ]
        r_build = run_command(cargo_build_cmd)
        wasm_built = WASM_BUILD_ARTIFACT.is_file()
        stage3 = {
            "status": "PASSED" if r_build["exit_code"] == 0 and wasm_built else "FAILED",
            "cmd": r_build["cmd"],
            "exit_code": r_build["exit_code"],
            "duration_sec": r_build["duration_sec"],
            "artifact": str(WASM_BUILD_ARTIFACT) if wasm_built else None,
            "stdout": r_build["stdout"],
            "stderr": r_build["stderr"],
        }
        if stage3["status"] == "PASSED":
            print(f"  Result: PASSED ({r_build['duration_sec']:.2f}s)")
            print(f"  Artifact: {WASM_BUILD_ARTIFACT} ({WASM_BUILD_ARTIFACT.stat().st_size} bytes)")
        else:
            print(f"  Result: FAILED (exit {r_build['exit_code']})")
            report["blockers"].append(f"WASM build failed: {r_build['stderr'][:200]}")

    report["stages"]["3_wasm_build"] = stage3

    # -------------------------------------------------------------------------
    # Stage 4: Node.js WASM Acceptance Verification (check-wasm.cjs)
    # -------------------------------------------------------------------------
    print("\n[Stage 4/6] Node.js WASM Acceptance Check (check-wasm.cjs)...")
    stage4 = {"status": "UNRUN"}
    if stage3.get("status") == "PASSED" and WASM_BUILD_ARTIFACT.is_file():
        node_check_cmd = [
            "node",
            str(ROOT_DIR / "phase0a" / "check-wasm.cjs"),
            "--wasm",
            str(WASM_BUILD_ARTIFACT),
            "--json",
        ]
        r_node_check = run_command(node_check_cmd)
        try:
            check_data = json.loads(r_node_check["stdout"])
            check_status = check_data.get("status", "UNKNOWN")
            # Strict rule: BOTH exit code == 0 AND check_status == 'PASSED'
            is_acceptance_passed = (r_node_check["exit_code"] == 0) and (check_status == "PASSED")
            stage4 = {
                "status": "PASSED" if is_acceptance_passed else "FAILED",
                "exit_code": r_node_check["exit_code"],
                "duration_sec": r_node_check["duration_sec"],
                "details": check_data,
            }
            print(f"  Result: {stage4['status']} (exit {r_node_check['exit_code']}, check_status: {check_status})")
            if not is_acceptance_passed:
                report["blockers"].append("check-wasm.cjs acceptance check did not achieve complete pass.")
        except Exception as e:
            stage4 = {
                "status": "FAILED",
                "exit_code": r_node_check["exit_code"],
                "stdout": r_node_check["stdout"],
                "stderr": r_node_check["stderr"],
                "error": str(e),
            }
            print(f"  Result: FAILED (Invalid output: {e})")
            report["blockers"].append("check-wasm.cjs execution failed or returned invalid JSON.")
    else:
        stage4 = {
            "status": "UNRUN",
            "reason": "No compiled WASM binary available to verify.",
        }
        print("  Result: UNRUN (No WASM artifact)")

    report["stages"]["4_node_acceptance"] = stage4

    # -------------------------------------------------------------------------
    # Stage 5: Synchronize WASM and Host to WeChat Probe (ONLY after Stage 4 passes)
    # -------------------------------------------------------------------------
    print("\n[Stage 5/6] Synchronizing Verified Artifact & Host Module to WeChat Probe...")
    stage5 = {"status": "UNRUN", "synchronized": False}
    if stage4.get("status") == "PASSED" and WASM_BUILD_ARTIFACT.is_file():
        try:
            # 1. Copy wasm binary
            shutil.copy2(WASM_BUILD_ARTIFACT, DEST_WASM_ARTIFACT)
            wasm_sha = sha256_file(DEST_WASM_ARTIFACT)

            # 2. Copy host.cjs to host.js (byte-for-byte identical, preventing logic drift)
            shutil.copy2(SRC_HOST_CJS, DEST_HOST_JS)
            host_sha = sha256_file(DEST_HOST_JS)

            stage5 = {
                "status": "PASSED",
                "synchronized": True,
                "wasm_artifact": {
                    "destination": str(DEST_WASM_ARTIFACT),
                    "bytes": DEST_WASM_ARTIFACT.stat().st_size,
                    "sha256": wasm_sha,
                },
                "host_module": {
                    "destination": str(DEST_HOST_JS),
                    "bytes": DEST_HOST_JS.stat().st_size,
                    "sha256": host_sha,
                },
            }
            print(f"  Result: PASSED")
            print(f"    WASM: {DEST_WASM_ARTIFACT} (sha256: {wasm_sha[:16]}...)")
            print(f"    Host: {DEST_HOST_JS} (sha256: {host_sha[:16]}...)")
        except Exception as e:
            stage5 = {"status": "FAILED", "synchronized": False, "error": str(e)}
            print(f"  Result: FAILED ({e})")
            report["blockers"].append(f"Asset synchronization failed: {e}")
    else:
        stage5 = {
            "status": "SKIPPED",
            "synchronized": False,
            "reason": "Node acceptance check did not pass; unverified artifacts must not be published to WeChat probe.",
        }
        print("  Result: SKIPPED (Node acceptance not passed)")

    report["stages"]["5_asset_and_host_sync"] = stage5

    # -------------------------------------------------------------------------
    # Stage 6: WeChat Real-Device Verification Status (Strictly UNRUN)
    # -------------------------------------------------------------------------
    print("\n[Stage 6/6] WeChat Mini Program Real-Device Verification...")
    stage6 = {
        "status": "UNRUN",
        "description": "Requires manual execution on WeChat Developer Tools or target mobile device.",
        "project_path": str(WECHAT_DIR),
        "procedure": [
            "1. Open WeChat Developer Tools -> Import Project.",
            "2. Select directory: rs-core/phase0a/wechat-probe",
            "3. Ensure assets/noise_wasm.wasm is present.",
            "4. Click '执行 Phase 0A 探针测试' button.",
            "5. Record WeChat version, base library (SDKVersion), platform, and step outcomes.",
        ],
        "device_evidence": None,
    }
    print("  Result: UNRUN (Awaiting manual execution on WeChat DevTools / Real Device)")
    report["stages"]["6_wechat_device_verification"] = stage6

    # -------------------------------------------------------------------------
    # Summary & Report Output
    # -------------------------------------------------------------------------
    all_stages_passed = (
        preflight.get("status") == "PASSED"
        and stage2.get("status") == "PASSED"
        and stage3.get("status") == "PASSED"
        and stage4.get("status") == "PASSED"
        and stage5.get("status") == "PASSED"
    )

    if not preflight["lockfile_present"]:
        report["overall_status"] = "BLOCKED_ON_MISSING_LOCKFILE"
        exit_code = 1
    elif not has_target:
        report["overall_status"] = "BLOCKED_ON_TOOLCHAIN_TARGET"
        exit_code = 2
    elif all_stages_passed:
        report["overall_status"] = "PASSED_HOST_VERIFICATION_PENDING_WECHAT_DEVICE"
        exit_code = 0
    else:
        report["overall_status"] = "FAILED"
        exit_code = 1

    report_file = REPORTS_DIR / "phase0a-report.json"
    with open(report_file, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print("\n=================================================================")
    print(f" Phase 0A Verification Completed with Status: {report['overall_status']}")
    print(f" Report Written to: {report_file}")
    if report["blockers"]:
        print("\n Blockers / Action Items for Operator:")
        for idx, b in enumerate(report["blockers"], 1):
            print(f"   {idx}. {b}")
    print("=================================================================")

    return exit_code


if __name__ == "__main__":
    sys.exit(main())
