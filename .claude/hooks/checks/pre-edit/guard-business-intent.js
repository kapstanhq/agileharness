// Check: guard-business-intent (pre-edit mirror of the pre-write version).
// Edit and Write share the same guard logic; the shared implementation already
// handles both tool shapes (Write.content / Edit.old_string+new_string). Delegate.
module.exports = require('../pre-write/guard-business-intent.js');
