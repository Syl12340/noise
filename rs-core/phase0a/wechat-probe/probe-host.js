/**
 * Phase 0A: Universal WASM Probe Host Module
 *
 * Implements Phase 0A ABI v1 host contract:
 * - Injectable instantiate function (supports Node.js Buffer and WeChat WXWebAssembly path)
 * - Duck-typed memory verification (zero dependence on global WebAssembly.Memory)
 * - Strict unsigned 32-bit integer host validation for len (no silent wrapping)
 * - Strict handshake, alignment, and non-overlapping boundary checks
 * - Always-fresh typed array views against memory.buffer
 * - Trap containment: invalidated instances are marked disposed
 * - Bit-exact IEEE-754 validation against frozen test vectors using exact dyadic sentinels
 * - Whole-buffer (4096 samples) immutability verification upon any validation failure
 */

'use strict';

const PROBE_ABI_VERSION = 1;
const PROBE_CAPACITY = 4096;
const BYTES_PER_SAMPLE = 4; // f32 is 4 bytes
const BUFFER_BYTES = PROBE_CAPACITY * BYTES_PER_SAMPLE; // 16384 bytes

// Pre-frozen test vectors per IMPLEMENTATION_BRIEF.md
const FROZEN_VECTOR = {
  input: Object.freeze([-1.0, -0.5, 0.0, 0.25, 1.0]),
  gain: 0.5,
  expected: Object.freeze([-0.5, -0.25, 0.0, 0.125, 0.5]),
};

// ABI Return codes
const ERR_OK = 0;
const ERR_LEN_OVERFLOW = -1;
const ERR_NON_FINITE_GAIN = -2;
const ERR_NON_FINITE_INPUT = -3;
const ERR_NON_FINITE_PRODUCT = -4;

const VALID_RETURN_CODES = new Set([
  ERR_OK,
  ERR_LEN_OVERFLOW,
  ERR_NON_FINITE_GAIN,
  ERR_NON_FINITE_INPUT,
  ERR_NON_FINITE_PRODUCT,
]);

/**
 * Validates that a pointer is a non-negative, 4-byte aligned unsigned 32-bit integer.
 * @param {any} ptr
 * @returns {boolean}
 */
function isValidU32Pointer(ptr) {
  return typeof ptr === 'number' && Number.isInteger(ptr) && ptr >= 0 && ptr <= 0xFFFFFFFF && ptr % 4 === 0;
}

/**
 * Compares two 32-bit floats bit-for-bit using an IEEE-754 uint32 view.
 * @param {number} actual
 * @param {number} expected
 * @returns {{ match: boolean, actualBits: string, expectedBits: string }}
 */
function compareFloat32Bits(actual, expected) {
  const buf = new ArrayBuffer(8);
  const f32View = new Float32Array(buf, 0, 2);
  const u32View = new Uint32Array(buf, 0, 2);

  f32View[0] = actual;
  f32View[1] = expected;

  const actualBits = u32View[0];
  const expectedBits = u32View[1];

  return {
    match: actualBits === expectedBits,
    actualBits: '0x' + actualBits.toString(16).padStart(8, '0').toUpperCase(),
    expectedBits: '0x' + expectedBits.toString(16).padStart(8, '0').toUpperCase(),
  };
}

/**
 * Wrapper managing a single WebAssembly probe instance.
 */
class ProbeHostInstance {
  /**
   * @param {object} instance - Raw WebAssembly / WXWebAssembly instance
   * @param {object} metadata
   */
  constructor(instance, metadata) {
    this.rawInstance = instance;
    this.exports = instance.exports;
    this.abiVersion = metadata.abiVersion;
    this.capacity = metadata.capacity;
    this.inputPtr = metadata.inputPtr;
    this.outputPtr = metadata.outputPtr;
    this.disposed = false;
    this.disposeReason = null;
  }

  /**
   * Asserts the instance has not been trapped or invalidated.
   */
  _assertAlive() {
    if (this.disposed) {
      throw new Error(`ProbeInstance is disposed (${this.disposeReason || 'trapped'}). Stale reads prohibited.`);
    }
  }

  /**
   * Mark instance as disposed following a trap or contract violation.
   * @param {string} reason
   */
  invalidate(reason) {
    this.disposed = true;
    this.disposeReason = reason;
  }

  /**
   * Acquires fresh Float32Array views directly over current memory.buffer.
   * NEVER cache views across operations, as memory.grow detaches old ArrayBuffers.
   * @returns {{ input: Float32Array, output: Float32Array, buffer: ArrayBuffer }}
   */
  getFreshViews() {
    this._assertAlive();
    const memory = this.exports.memory;
    if (!memory || !memory.buffer || !(memory.buffer instanceof ArrayBuffer)) {
      this.invalidate('Invalid memory export');
      throw new Error('WebAssembly memory export missing or invalid buffer');
    }

    const buf = memory.buffer;
    const byteLen = buf.byteLength;

    if (this.inputPtr + BUFFER_BYTES > byteLen || this.outputPtr + BUFFER_BYTES > byteLen) {
      this.invalidate('Memory buffer boundary violation');
      throw new Error(`Memory buffer (${byteLen} bytes) is too small for probe buffers (${BUFFER_BYTES} bytes each)`);
    }

    return {
      input: new Float32Array(buf, this.inputPtr, this.capacity),
      output: new Float32Array(buf, this.outputPtr, this.capacity),
      buffer: buf,
    };
  }

  /**
   * Resets input and output buffers to zero inside WASM.
   */
  reset() {
    this._assertAlive();
    try {
      this.exports.probe_reset();
    } catch (err) {
      this.invalidate(`Trap during probe_reset: ${err.message}`);
      throw err;
    }
  }

  /**
   * Executes probe_process in WASM with strict host-level validation of arguments.
   *
   * @param {number} len - Requested length (must be unsigned 32-bit integer: 0 <= len <= 0xFFFFFFFF)
   * @param {number} gain - Gain multiplier (must be number)
   * @returns {number} Return code: 0, -1, -2, -3, or -4
   */
  process(len, gain) {
    this._assertAlive();

    // Host-level parameter validation: reject invalid types/ranges before invoking WASM
    // Prevents negative numbers, decimals, or > 2^32 from silent wrapping
    if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > 0xFFFFFFFF) {
      throw new TypeError(`Invalid len argument: ${len} (must be unsigned 32-bit integer in [0, 4294967295])`);
    }
    if (typeof gain !== 'number') {
      throw new TypeError(`Invalid gain argument: ${gain} (must be a number)`);
    }

    let ret;
    try {
      ret = this.exports.probe_process(len, gain);
    } catch (err) {
      this.invalidate(`Trap during probe_process: ${err.message}`);
      throw err;
    }

    // Verify return code matches ABI v1 specification
    if (!VALID_RETURN_CODES.has(ret)) {
      this.invalidate(`Unknown return code from probe_process: ${ret}`);
      throw new Error(`probe_process returned unknown return code: ${ret}`);
    }

    return ret;
  }

  /**
   * Deliberately triggers a WebAssembly trap via probe_force_trap.
   * The instance MUST be invalidated upon trap or upon unexpected return.
   */
  forceTrap() {
    this._assertAlive();
    let trapped = false;
    try {
      this.exports.probe_force_trap();
    } catch (err) {
      trapped = true;
      this.invalidate(`Instance trapped via probe_force_trap: ${err.message}`);
      throw err;
    }

    // Contract violation: probe_force_trap returned without trapping
    if (!trapped) {
      this.invalidate('probe_force_trap returned unexpectedly without trapping');
      throw new Error('probe_force_trap returned unexpectedly without trapping (contract violation)');
    }
  }
}

/**
 * Handshake and validation of a raw WebAssembly / WXWebAssembly instance.
 * Avoids instanceof WebAssembly.Memory to ensure compatibility with WeChat runtime.
 *
 * @param {object} instance
 * @returns {ProbeHostInstance}
 */
function handshakeAndWrap(instance) {
  if (!instance || !instance.exports) {
    throw new Error('Invalid WebAssembly instance: no exports found');
  }

  const exp = instance.exports;
  const requiredFns = [
    'probe_abi_version',
    'probe_capacity',
    'probe_input_ptr',
    'probe_output_ptr',
    'probe_process',
    'probe_reset',
    'probe_force_trap',
  ];

  for (const fnName of requiredFns) {
    if (typeof exp[fnName] !== 'function') {
      throw new Error(`Missing required probe export function: ${fnName}`);
    }
  }

  // Duck-typed memory verification: does not rely on global WebAssembly.Memory
  if (
    !exp.memory ||
    typeof exp.memory !== 'object' ||
    !(exp.memory.buffer instanceof ArrayBuffer) ||
    typeof exp.memory.grow !== 'function'
  ) {
    throw new Error('Missing or invalid "memory" export: must provide ArrayBuffer buffer and grow() method');
  }

  // ABI Version Check
  const abiVersion = exp.probe_abi_version();
  if (abiVersion !== PROBE_ABI_VERSION) {
    throw new Error(`ABI version mismatch: expected ${PROBE_ABI_VERSION}, received ${abiVersion}`);
  }

  // Capacity Check
  const capacity = exp.probe_capacity();
  if (capacity !== PROBE_CAPACITY) {
    throw new Error(`Capacity mismatch: expected ${PROBE_CAPACITY}, received ${capacity}`);
  }

  // Buffer Pointer & Alignment Checks
  const inputPtr = exp.probe_input_ptr();
  const outputPtr = exp.probe_output_ptr();

  if (!isValidU32Pointer(inputPtr)) {
    throw new Error(`Invalid input pointer: ${inputPtr} (must be non-negative 4-byte aligned u32)`);
  }
  if (!isValidU32Pointer(outputPtr)) {
    throw new Error(`Invalid output pointer: ${outputPtr} (must be non-negative 4-byte aligned u32)`);
  }

  // Memory Boundary & Non-overlapping checks
  const memByteLen = exp.memory.buffer.byteLength;
  if (inputPtr + BUFFER_BYTES > memByteLen) {
    throw new Error(`Input buffer [${inputPtr}, ${inputPtr + BUFFER_BYTES}) exceeds memory bounds (${memByteLen})`);
  }
  if (outputPtr + BUFFER_BYTES > memByteLen) {
    throw new Error(`Output buffer [${outputPtr}, ${outputPtr + BUFFER_BYTES}) exceeds memory bounds (${memByteLen})`);
  }

  const inEnd = inputPtr + BUFFER_BYTES;
  const outEnd = outputPtr + BUFFER_BYTES;
  // Overlap condition: max(start) < min(end)
  if (Math.max(inputPtr, outputPtr) < Math.min(inEnd, outEnd)) {
    throw new Error(`Input [${inputPtr}, ${inEnd}) and Output [${outputPtr}, ${outEnd}) buffers overlap!`);
  }

  return new ProbeHostInstance(instance, {
    abiVersion,
    capacity,
    inputPtr,
    outputPtr,
  });
}

/**
 * Creates and initializes a ProbeHostInstance via an injectable instantiate function.
 * Supports both Node.js ({ instance, module }) and WeChat WXWebAssembly (direct Instance).
 *
 * @param {object} options
 * @param {Function} options.instantiateFn
 * @param {any} options.source
 * @param {object} [options.imports]
 * @returns {Promise<ProbeHostInstance>}
 */
async function createProbeHost(options) {
  if (!options || typeof options.instantiateFn !== 'function') {
    throw new Error('createProbeHost requires an instantiateFn');
  }

  const imports = options.imports || {};
  const result = await options.instantiateFn(options.source, imports);

  // Result may be { instance, module } (Node standard) or direct instance (WeChat WXWebAssembly)
  const rawInstance = result && result.instance ? result.instance : result;
  return handshakeAndWrap(rawInstance);
}

/**
 * Verifies that all 4096 samples of the output buffer are bitwise identical to an expected exact f32 sentinel.
 * @param {Float32Array} outputView
 * @param {number} expectedExactValue
 * @returns {boolean}
 */
function verifyAllOutputEquals(outputView, expectedExactValue) {
  const cmp = compareFloat32Bits(outputView[0], expectedExactValue);
  if (!cmp.match) return false;
  const targetBits = new Uint32Array(new Float32Array([expectedExactValue]).buffer)[0];
  const u32Output = new Uint32Array(outputView.buffer, outputView.byteOffset, outputView.length);
  for (let i = 0; i < u32Output.length; i++) {
    if (u32Output[i] !== targetBits) {
      return false;
    }
  }
  return true;
}

/**
 * Runs the standard frozen test vector and parameter verification suite.
 * Tests use exact dyadic sentinels and verify whole 4096-sample buffer immutability upon failure.
 *
 * @param {ProbeHostInstance} probe
 * @returns {{ passed: boolean, details: Array<{ name: string, passed: boolean, message?: string }> }}
 */
function runProbeSuite(probe) {
  const details = [];

  function record(name, pass, msg) {
    details.push({ name, passed: Boolean(pass), message: msg || (pass ? 'PASS' : 'FAIL') });
  }

  try {
    // 1. Reset: verify all 4096 elements in both buffers are 0.0
    let views = probe.getFreshViews();
    views.input.fill(42.0);
    views.output.fill(84.0);
    probe.reset();
    views = probe.getFreshViews();
    const resetInputOk = verifyAllOutputEquals(views.input, 0.0);
    const resetOutputOk = verifyAllOutputEquals(views.output, 0.0);
    record('probe_reset_full_4096_zeroed', resetInputOk && resetOutputOk, 'All 4096 samples zeroed in both buffers');

    // 2. Frozen Test Vector Exact Bitwise Check & Remaining Buffer Untouched Check
    probe.reset();
    views = probe.getFreshViews();
    // Fill output with exact dyadic sentinel 64.0
    views.output.fill(64.0);
    for (let i = 0; i < FROZEN_VECTOR.input.length; i++) {
      views.input[i] = FROZEN_VECTOR.input[i];
    }
    const retVec = probe.process(FROZEN_VECTOR.input.length, FROZEN_VECTOR.gain);
    if (retVec !== ERR_OK) {
      record('frozen_vector_execution', false, `probe_process returned ${retVec}`);
    } else {
      views = probe.getFreshViews();
      let bitwisePassed = true;
      let mismatchInfo = '';
      for (let i = 0; i < FROZEN_VECTOR.expected.length; i++) {
        const cmp = compareFloat32Bits(views.output[i], FROZEN_VECTOR.expected[i]);
        if (!cmp.match) {
          bitwisePassed = false;
          mismatchInfo = `Index ${i}: got ${cmp.actualBits}, expected ${cmp.expectedBits}`;
          break;
        }
      }
      record('frozen_vector_bitwise_exact', bitwisePassed, bitwisePassed ? 'Bitwise identical' : mismatchInfo);

      // Verify samples beyond len (5..4095) remain untouched
      let restUntouched = true;
      for (let i = FROZEN_VECTOR.input.length; i < PROBE_CAPACITY; i++) {
        if (views.output[i] !== 64.0) {
          restUntouched = false;
          break;
        }
      }
      record('output_samples_beyond_len_untouched', restUntouched, 'Samples 5..4095 preserved untouched');
    }

    // 3. Length = 0 Preservation Check (all 4096 samples must remain untouched)
    views = probe.getFreshViews();
    views.output.fill(128.5); // Exact dyadic float in f32
    const retZero = probe.process(0, 0.5);
    views = probe.getFreshViews();
    const lenZeroPreserved = retZero === ERR_OK && verifyAllOutputEquals(views.output, 128.5);
    record('len_zero_preserves_all_4096_outputs', lenZeroPreserved, 'All 4096 output samples untouched');

    // 4. Host Parameter Validation: negative len, non-integer len, > 0xFFFFFFFF len
    let hostLenRejected = false;
    try {
      probe.process(-1, 1.0);
    } catch (e1) {
      try {
        probe.process(3.5, 1.0);
      } catch (e2) {
        try {
          probe.process(0x100000000, 1.0); // 2^32
          hostLenRejected = false;
        } catch (e3) {
          hostLenRejected = true;
        }
      }
    }
    record('host_len_parameter_validation', hostLenRejected, 'Negative, decimal, and > u32::MAX rejected at host');

    // 5. Capacity Boundaries (4096 pass, 4097 rejected with whole output untouched, u32::MAX rejected)
    views = probe.getFreshViews();
    views.input.fill(0.25);
    const retCap = probe.process(PROBE_CAPACITY, 2.0);
    views = probe.getFreshViews();
    const cap4096Pass = retCap === ERR_OK && verifyAllOutputEquals(views.output, 0.5);
    record('capacity_4096_pass', cap4096Pass, 'Full 4096-sample capacity succeeded');

    // 4097 overflow check
    views.output.fill(32.0);
    const ret4097 = probe.process(PROBE_CAPACITY + 1, 2.0);
    views = probe.getFreshViews();
    const overflow4097Ok = ret4097 === ERR_LEN_OVERFLOW && verifyAllOutputEquals(views.output, 32.0);
    record('capacity_4097_rejected_with_immutability', overflow4097Ok, 'len=4097 returned -1 with all 4096 samples unchanged');

    // u32::MAX overflow check
    views.output.fill(32.0);
    const retU32Max = probe.process(0xFFFFFFFF, 2.0);
    views = probe.getFreshViews();
    const overflowU32MaxOk = retU32Max === ERR_LEN_OVERFLOW && verifyAllOutputEquals(views.output, 32.0);
    record('capacity_u32max_rejected_with_immutability', overflowU32MaxOk, 'len=u32::MAX returned -1 with all 4096 samples unchanged');

    // 6. Independent Non-Finite Gain Rejection (reset inputs and check immutability for each)
    views = probe.getFreshViews();
    views.input.fill(1.0);

    // NaN gain
    views.output.fill(16.0);
    const retGainNan = probe.process(5, NaN);
    views = probe.getFreshViews();
    const gainNanOk = retGainNan === ERR_NON_FINITE_GAIN && verifyAllOutputEquals(views.output, 16.0);
    record('gain_nan_rejected_with_immutability', gainNanOk, 'gain=NaN returned -2, output unchanged');

    // +Inf gain
    views.output.fill(16.0);
    const retGainPosInf = probe.process(5, Infinity);
    views = probe.getFreshViews();
    const gainPosInfOk = retGainPosInf === ERR_NON_FINITE_GAIN && verifyAllOutputEquals(views.output, 16.0);
    record('gain_pos_inf_rejected_with_immutability', gainPosInfOk, 'gain=+Inf returned -2, output unchanged');

    // -Inf gain
    views.output.fill(16.0);
    const retGainNegInf = probe.process(5, -Infinity);
    views = probe.getFreshViews();
    const gainNegInfOk = retGainNegInf === ERR_NON_FINITE_GAIN && verifyAllOutputEquals(views.output, 16.0);
    record('gain_neg_inf_rejected_with_immutability', gainNegInfOk, 'gain=-Inf returned -2, output unchanged');

    // Gain f32 overflow (1e39 > f32::MAX)
    views.output.fill(16.0);
    const retGainOverflow = probe.process(5, 1e39);
    views = probe.getFreshViews();
    const gainOverflowOk = retGainOverflow === ERR_NON_FINITE_GAIN && verifyAllOutputEquals(views.output, 16.0);
    record('gain_f32_overflow_rejected', gainOverflowOk, 'gain=1e39 returned -2, output unchanged');

    // 7. Independent Non-Finite Input Rejection (reset inputs clean first each time)
    // Case A: NaN input
    views = probe.getFreshViews();
    views.input.fill(1.0);
    views.input[2] = NaN;
    views.output.fill(8.0);
    const retInNan = probe.process(5, 1.0);
    views = probe.getFreshViews();
    const inNanOk = retInNan === ERR_NON_FINITE_INPUT && verifyAllOutputEquals(views.output, 8.0);
    record('input_nan_rejected_with_immutability', inNanOk, 'input=NaN returned -3, output unchanged');

    // Case B: +Inf input (fresh clean inputs, no leftover NaN)
    views = probe.getFreshViews();
    views.input.fill(1.0);
    views.input[0] = Infinity;
    views.output.fill(8.0);
    const retInPosInf = probe.process(5, 1.0);
    views = probe.getFreshViews();
    const inPosInfOk = retInPosInf === ERR_NON_FINITE_INPUT && verifyAllOutputEquals(views.output, 8.0);
    record('input_pos_inf_rejected_with_immutability', inPosInfOk, 'input=+Inf returned -3, output unchanged');

    // Case C: -Inf input (fresh clean inputs)
    views = probe.getFreshViews();
    views.input.fill(1.0);
    views.input[4] = -Infinity;
    views.output.fill(8.0);
    const retInNegInf = probe.process(5, 1.0);
    views = probe.getFreshViews();
    const inNegInfOk = retInNegInf === ERR_NON_FINITE_INPUT && verifyAllOutputEquals(views.output, 8.0);
    record('input_neg_inf_rejected_with_immutability', inNegInfOk, 'input=-Inf returned -3, output unchanged');

    // 8. Product Overflow Rejection (both positive and negative overflow)
    // Case A: Positive overflow (+Inf)
    views = probe.getFreshViews();
    views.input.fill(1.0);
    views.input[3] = 1e38;
    views.output.fill(4.0);
    const retProdPosOver = probe.process(5, 10.0);
    views = probe.getFreshViews();
    const prodPosOverOk = retProdPosOver === ERR_NON_FINITE_PRODUCT && verifyAllOutputEquals(views.output, 4.0);
    record('product_pos_overflow_rejected_with_immutability', prodPosOverOk, 'prod=+Inf returned -4, output unchanged');

    // Case B: Negative overflow (-Inf)
    views = probe.getFreshViews();
    views.input.fill(1.0);
    views.input[3] = -1e38;
    views.output.fill(4.0);
    const retProdNegOver = probe.process(5, 10.0);
    views = probe.getFreshViews();
    const prodNegOverOk = retProdNegOver === ERR_NON_FINITE_PRODUCT && verifyAllOutputEquals(views.output, 4.0);
    record('product_neg_overflow_rejected_with_immutability', prodNegOverOk, 'prod=-Inf returned -4, output unchanged');

  } catch (err) {
    record('suite_execution_error', false, err.message);
  }

  const allPassed = details.every((d) => d.passed);
  return { passed: allPassed, details };
}

module.exports = {
  PROBE_ABI_VERSION,
  PROBE_CAPACITY,
  BUFFER_BYTES,
  FROZEN_VECTOR,
  ERR_OK,
  ERR_LEN_OVERFLOW,
  ERR_NON_FINITE_GAIN,
  ERR_NON_FINITE_INPUT,
  ERR_NON_FINITE_PRODUCT,
  isValidU32Pointer,
  compareFloat32Bits,
  verifyAllOutputEquals,
  ProbeHostInstance,
  handshakeAndWrap,
  createProbeHost,
  runProbeSuite,
};
