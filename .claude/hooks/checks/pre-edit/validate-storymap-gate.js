// Check: validate-storymap-gate (pre-edit mirror of the pre-write version).
// Edit and Write share the same gate logic; Edit exposes the post-edit text via
// tool_input.new_string, which the shared implementation already reads. So we
// just delegate, exactly like block-root-artifacts does.
module.exports = require('../pre-write/validate-storymap-gate.js');
