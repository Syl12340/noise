#!/usr/bin/env node
/**
 * Phase 0A: WASM Artifact Acceptance & Verification Script
 *
 * Verifies real compiled .wasm artifact against Phase 0A requirements:
 * 1. Checks artifact presence (clean UNRUN exit code 2 if artifact is missing)
 * 2. Size in bytes and SHA-256 checksum
 * 3. Module reflection: imports (must be clean 0 imports for no_std probe), exports
 * 4. Handshake, memory bounds, alignment, non-overlapping buffers
 * 5. Bit-exact IEEE-754 validation against frozen vectors with whole 4096-sample checks
 * 6. Boundary, non-finite, and overflow rejection checks with immutability guarantees
 * 7. memory.grow detached buffer & fresh views verification (address & alignment stability)
 * 8. Two concurrently live instances isolation test (no cross-instance interference)
 * 9. Trap injection & WebAssembly.RuntimeError type check + instance invalidation & recovery
 * 10. Environment telemetry, timing, and memory observation
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {
  createProbeHost,
  runProbeSuite,
  verifyAllOutputEquals,
  PROBE_ABI_VERSION,
  PROBE_CAPACITY,
  ERR_OK,
} = require('./probe-host.cjs');

// Candidate locations for the compiled wasm binary
const CANDIDATE_PATHS = [
  path.resolve(__dirname, '../target/wasm32v1-none/release/noise_wasm.wasm'),
  path.resolve(__dirname, '../target/wasm32v1-none/release/noise-wasm.wasm'),
  path.resolve(__dirname, './wechat-probe/assets/noise_wasm.wasm'),
];

function parseArgs() {
  const args = process.argv.slice(2);
  let wasmPath = null;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wasm' && i + 1 < args.length) {
      wasmPath = path.resolve(process.cwd(), args[++i]);
    } else if (args[i] === '--json') {
      jsonOutput = true;
    } else if (!args[i].startsWith('--') && !wasmPath) {
      wasmPath = path.resolve(process.cwd(), args[i]);
    }
  }

  return { wasmPath, jsonOutput };
}

function resolveWasmFile(explicitPath) {
  if (explicitPath) {
    if (fs.existsSync(explicitPath)) {
      return explicitPath;
    }
    return null;
  }
  for (const p of CANDIDATE_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function main() {
  const { wasmPath: explicitPath, jsonOutput } = parseArgs();
  const resolvedPath = resolveWasmFile(explicitPath);

  const report = {
    timestamp: new Date().toISOString(),
    status: 'UNKNOWN',
    system: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      osType: os.type(),
      osRelease: os.release(),
      cpuModel: os.cpus()[0] ? os.cpus()[0].model : 'unknown',
    },
    artifact: null,
    moduleReflection: null,
    tests: [],
    telemetry: {},
    error: null,
  };

  if (!resolvedPath) {
    report.status = 'UNRUN';
    report.error = 'No compiled .wasm binary found at candidate paths.';
    report.checkedPaths = explicitPath ? [explicitPath] : CANDIDATE_PATHS;

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('======================================================');
      console.log(' PHASE 0A: WASM ACCEPTANCE CHECK');
      console.log(' STATUS: UNRUN');
      console.log(' REASON: WebAssembly binary not found.');
      console.log(' Candidates searched:');
      for (const p of report.checkedPaths) {
        console.log(`   - ${p}`);
      }
      console.log('\n Please compile the WASM binary first:');
      console.log('   cargo build --target wasm32v1-none --release --locked --offline -p noise-wasm');
      console.log('======================================================');
    }
    process.exit(2);
  }

  // Read binary artifact
  const wasmBuffer = fs.readFileSync(resolvedPath);
  const hash = crypto.createHash('sha256').update(wasmBuffer).digest('hex');

  report.artifact = {
    path: resolvedPath,
    bytes: wasmBuffer.byteLength,
    sha256: hash,
  };

  function logCheck(name, passed, detail) {
    report.tests.push({ name, passed: Boolean(passed), detail: detail || '' });
    if (!jsonOutput) {
      const tag = passed ? '[PASS]' : '[FAIL]';
      console.log(`  ${tag} ${name}${detail ? ` - ${detail}` : ''}`);
    }
  }

  if (!jsonOutput) {
    console.log('======================================================');
    console.log(' PHASE 0A: WASM ACCEPTANCE & RUNTIME VERIFICATION');
    console.log('======================================================');
    console.log(` Artifact Path : ${resolvedPath}`);
    console.log(` Binary Size   : ${wasmBuffer.byteLength} bytes`);
    console.log(` SHA-256       : ${hash}`);
    console.log(` Environment   : Node ${process.version} (${process.platform} ${process.arch})`);
    console.log('------------------------------------------------------');
  }

  try {
    // 1. Module Compilation and Reflection
    const wasmModule = await WebAssembly.compile(wasmBuffer);
    const imports = WebAssembly.Module.imports(wasmModule);
    const exports = WebAssembly.Module.exports(wasmModule);

    report.moduleReflection = {
      importsCount: imports.length,
      imports: imports,
      exportsCount: exports.length,
      exports: exports.map((e) => `${e.name} (${e.kind})`),
    };

    // Module imports MUST be 0 for standalone no_std probe
    const cleanImports = imports.length === 0;
    logCheck(
      'module_imports_clean',
      cleanImports,
      cleanImports ? '0 external imports' : `Found ${imports.length} imports: ${JSON.stringify(imports)}`
    );

    // 2. Instantiate and Handshake
    const instantiateFn = async (buf, imp) => WebAssembly.instantiate(buf, imp);
    const probe = await createProbeHost({
      instantiateFn,
      source: wasmBuffer,
    });

    logCheck('handshake_abi_version', probe.abiVersion === PROBE_ABI_VERSION, `ABI version = ${probe.abiVersion}`);
    logCheck('handshake_capacity', probe.capacity === PROBE_CAPACITY, `Capacity = ${probe.capacity}`);
    logCheck('input_pointer_aligned', probe.inputPtr % 4 === 0, `0x${probe.inputPtr.toString(16)} (4-byte aligned)`);
    logCheck('output_pointer_aligned', probe.outputPtr % 4 === 0, `0x${probe.outputPtr.toString(16)} (4-byte aligned)`);

    // 3. Run Standard Functional & Numerical Suite (includes all 4096-sample immutability checks)
    const suiteResult = runProbeSuite(probe);
    for (const d of suiteResult.details) {
      logCheck(`functional_${d.name}`, d.passed, d.message);
    }

    // 4. Two Concurrently Live Instances Isolation Test
    let multiInstanceOk = false;
    let multiInstanceDetail = '';
    try {
      const probe1 = await createProbeHost({ instantiateFn, source: wasmBuffer });
      const probe2 = await createProbeHost({ instantiateFn, source: wasmBuffer });

      const views1 = probe1.getFreshViews();
      const views2 = probe2.getFreshViews();

      views1.input[0] = 10.0;
      views2.input[0] = 20.0;

      probe1.process(1, 2.0);
      probe2.process(1, 3.0);

      const out1 = probe1.getFreshViews().output[0];
      const out2 = probe2.getFreshViews().output[0];

      if (out1 === 20.0 && out2 === 60.0) {
        // Mutating probe1 must not affect probe2
        probe1.reset();
        const out2AfterReset = probe2.getFreshViews().output[0];
        if (out2AfterReset === 60.0) {
          multiInstanceOk = true;
          multiInstanceDetail = 'Two concurrently active instances maintain strictly isolated memories';
        } else {
          multiInstanceDetail = `Cross-talk detected: probe2 output changed to ${out2AfterReset} after probe1 reset`;
        }
      } else {
        multiInstanceDetail = `Output mismatch: probe1=${out1} (expected 20), probe2=${out2} (expected 60)`;
      }
    } catch (err) {
      multiInstanceOk = false;
      multiInstanceDetail = `Error: ${err.message}`;
    }
    logCheck('multi_instance_concurrent_isolation', multiInstanceOk, multiInstanceDetail);

    // 5. Memory.grow and Old View Invalidation Test
    let growTestPassed = false;
    let growDetail = '';
    try {
      const oldViews = probe.getFreshViews();
      const oldBuffer = oldViews.buffer;
      const initialByteLen = oldBuffer.byteLength;

      // Grow WASM linear memory by 1 page (64 KB)
      const prevPages = probe.rawInstance.exports.memory.grow(1);

      // Verify that old buffer is detached in conforming engines, or that new fresh view has expanded buffer
      const newViews = probe.getFreshViews();
      const newByteLen = newViews.buffer.byteLength;
      const bufferExpanded = newByteLen === initialByteLen + 65536;
      const oldBufferDetached = oldBuffer.byteLength === 0;

      // Verify probe still works after grow
      newViews.input[0] = 4.0;
      const retAfterGrow = probe.process(1, 2.0);
      const postGrowOutput = probe.getFreshViews().output[0];
      const execValid = retAfterGrow === ERR_OK && postGrowOutput === 8.0;

      // Verify pointers remain aligned and within bounds
      const inPtrStable = probe.exports.probe_input_ptr() === probe.inputPtr;
      const outPtrStable = probe.exports.probe_output_ptr() === probe.outputPtr;

      growTestPassed = bufferExpanded && execValid && inPtrStable && outPtrStable;
      growDetail = `Pages: ${prevPages}->${prevPages + 1}, Expanded: ${initialByteLen}->${newByteLen} bytes, Old Detached: ${oldBufferDetached}`;
    } catch (err) {
      growTestPassed = false;
      growDetail = `Error: ${err.message}`;
    }
    logCheck('memory_grow_fresh_view_resilience', growTestPassed, growDetail);

    // 6. Fault Injection Trap, RuntimeError Verification, and Recovery Test
    let trapTestPassed = false;
    let trapDetail = '';
    try {
      let caughtError = null;
      try {
        probe.forceTrap();
      } catch (trapErr) {
        caughtError = trapErr;
      }

      if (!caughtError) {
        trapDetail = 'probe_force_trap did not trigger an error!';
      } else {
        // Verify caught error is WebAssembly.RuntimeError
        const isRuntimeError = (caughtError instanceof WebAssembly.RuntimeError) ||
          caughtError.name === 'RuntimeError' ||
          String(caughtError.message).toLowerCase().includes('unreachable');

        if (!isRuntimeError) {
          trapDetail = `Expected WebAssembly.RuntimeError, got: ${caughtError.constructor.name} (${caughtError.message})`;
        } else if (!probe.disposed) {
          trapDetail = 'Probe instance was not marked disposed after trap!';
        } else {
          // Confirm that attempting to read or process on trapped instance is blocked
          let postTrapBlocked = false;
          try {
            probe.process(1, 1.0);
          } catch (e) {
            postTrapBlocked = true;
          }

          if (!postTrapBlocked) {
            trapDetail = 'Post-trap invocation was not blocked!';
          } else {
            // Verify Recovery: Instantiate a fresh instance and verify it functions
            const freshProbe = await createProbeHost({ instantiateFn, source: wasmBuffer });
            freshProbe.getFreshViews().input[0] = 10.0;
            const freshRet = freshProbe.process(1, 3.0);
            const freshOut = freshProbe.getFreshViews().output[0];

            if (freshRet === ERR_OK && freshOut === 30.0) {
              trapTestPassed = true;
              trapDetail = `RuntimeError verified (${caughtError.message}), instance disposed, new instance recovered cleanly`;
            } else {
              trapDetail = `Fresh instance returned unexpected output: ${freshOut}`;
            }
          }
        }
      }
    } catch (err) {
      trapTestPassed = false;
      trapDetail = `Unexpected error: ${err.message}`;
    }
    logCheck('trap_runtime_error_and_recovery', trapTestPassed, trapDetail);

    // 7. Telemetry & Performance Benchmark
    const benchmarkProbe = await createProbeHost({ instantiateFn, source: wasmBuffer });
    const views = benchmarkProbe.getFreshViews();
    views.input.fill(0.125);
    const warmupIterations = 100;
    const testIterations = 1000;

    for (let i = 0; i < warmupIterations; i++) {
      benchmarkProbe.process(PROBE_CAPACITY, 0.5);
    }

    const t0 = process.hrtime.bigint();
    for (let i = 0; i < testIterations; i++) {
      benchmarkProbe.process(PROBE_CAPACITY, 0.5);
    }
    const t1 = process.hrtime.bigint();

    const totalNs = Number(t1 - t0);
    const avgUs = totalNs / testIterations / 1000;

    report.telemetry = {
      benchmarkIterations: testIterations,
      totalDurationMs: totalNs / 1e6,
      averageProbeProcessUs: avgUs,
      memoryUsage: process.memoryUsage(),
    };

    if (!jsonOutput) {
      console.log('------------------------------------------------------');
      console.log(` Telemetry (4096-sample probe_process):`);
      console.log(`   Iterations : ${testIterations}`);
      console.log(`   Avg latency: ${avgUs.toFixed(3)} μs per 4096-sample frame`);
      console.log(`   Memory RSS : ${(process.memoryUsage().rss / 1024 / 1024).toFixed(2)} MB`);
      console.log('------------------------------------------------------');
    }

    const allPassed = report.tests.every((t) => t.passed);
    report.status = allPassed ? 'PASSED' : 'FAILED';

    if (!jsonOutput) {
      console.log(` OVERALL RESULT: ${report.status}`);
      console.log('======================================================');
    } else {
      console.log(JSON.stringify(report, null, 2));
    }

    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    report.status = 'FAILED';
    report.error = err.stack || err.message;
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.error(`FATAL ERROR during check-wasm: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
