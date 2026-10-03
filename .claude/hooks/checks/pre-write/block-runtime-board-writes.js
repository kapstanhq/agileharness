// Check: block-runtime-board-writes (pre-write mirror of the pre-edit version).
// Write and Edit carry the same `file_path` in tool_input, and the guard only reads that —
// so there is one implementation and this is a delegate. See ../pre-edit/ for the whole rule
// (D4 / WS-3.1), the G3 exemption and the stage-seal button.
module.exports = require('../pre-edit/block-runtime-board-writes.js');
