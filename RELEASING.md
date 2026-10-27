# Releasing

This project is released as part of the Tigo agent stack. The order, the manifest and the
checks are described once, in the Assistant repository:
https://github.com/convertigo/c8oprj-lib-convertigo-assistant/blob/master/RELEASING.md

## Pre-releases

Tagging a beta (`vX.Y.Z-beta.N`) publishes a GitHub pre-release and offers it to no Studio
yet. A beta reaches the **Pre-releases** update channel of Studios only once
`stack-release-preview.json` on `master` of the Assistant repository lists it, after it has
been installed and checked together with the Assistant and MCP on test-nocode.
Releasing this project does not do it: updating that manifest is the last step of the
checked set, see [the Assistant procedure](https://github.com/convertigo/c8oprj-lib-convertigo-assistant/blob/master/RELEASING.md#preview-manifest-after-a-checked-pre-release-set).
