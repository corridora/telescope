# Result contract fixtures

Static, synthetic captures for storage adapters, viewers, and future verification:

- `legacy/`: flat single-page output without a versioned result manifest.
- `complete/`: a published-format successful single-page capture.
- `partial/`: failed execution with available console/configuration diagnostics.
- `incomplete/`: an unfinished capture which must not be advertised as passed.

The `.invalid` target is metadata only. No browser or network execution is needed
to read these fixtures. Their manifest integrity fields describe the committed
fixture bytes; `result.json` excludes itself to avoid recursive hashing.

These files were generated as implementation inputs. Tests have not been run.
