# Review: github.com/bis3946/core at b0f6938

**Reviewed:** 30 October 2026 · **Commit:** `b0f693829951f28d354347df04e29d4afc4fcfde` · **Reproduce:** `scripts/check-nun-core.sh b0f6938`

This commit answers the review of `96a7dcf` (see the README). The checks below were run in Civilisation.One's environment with Lean 4.12.0, the toolchain the repository pins. Import the claims with [`examples/nun-core-b0f6938.json`](../../examples/nun-core-b0f6938.json); they arrive capped at HYPOTHESIS. The evidence below is what may raise them.

## Executed checks

| Check | Result |
|---|---|
| SHA-256 of `nun_quantum_proof.lean` vs `quantum_priority_hash.txt` | Both `e5809e31629ecaee805a6aef544f3e9974a51c20e90116f666f81935c2b7d92c` |
| `lean-toolchain`, `lakefile.lean` present | Yes, `leanprover/lean4:v4.12.0` |
| `lake build` | Build completed successfully (exit 0) |
| `sorry` in the proof file | 0 |
| `#print axioms` | `projection_idempotent`: none · `vfe_surplus_zero_after_projection`: `propext` · `vfe_pos_of_nonzero_entropy`: `propext` |
| Theorem 2 with `kB`, `tempK` unconstrained | Still holds, so positivity of the thermal parameters is not used |

## What the theorems establish

All three are correct, machine-checked statements about the definitions in the file, and each follows from those definitions in one or two steps:

1. `projection_idempotent`: zeroing `s2` twice equals zeroing it once (`rfl`).
2. `vfe_surplus_zero_after_projection`: `kB * tempK * (s2 * s2)` is 0 when `s2 = 0`, for any `kB`, `tempK`.
3. `vfe_pos_of_nonzero_entropy`: a product of positive integers is positive, for `s2 > 0`.

What they do not establish: that `kB * tempK * s2²` (in integers) is a variational free energy; that `s2` measures speculative content; that 295 K is involved (the file requires only `tempK > 0`; 295 K is a comment); any non-commutativity (named in a docstring, never stated); or the original claims at `d308670` (room-temperature quantum topos, VFE < 0.05, Stanford priority), which this commit does not address.

## Evidence to record

| Claim | Status here | Basis |
|---|---|---|
| c1 hash parity | **SUPPORTED** | Recomputed hash matches |
| c2 toolchain present, reproducible build | **SUPPORTED** | `lake build` exit 0 with the pinned toolchain |
| c3 non-trivial proof of collapse under `P_v` | **SUPPORTED** as mathematics about the file's own definitions; physical reading SPECULATION | Build, axioms, unconstrained check |
| c4 non-zero `s2` gives positive surplus | **SUPPORTED** for `s2 > 0` only, which is what is proved; the statement's "any non-zero" is not proved | Build |
| `VFE surplus` is a physical free energy at room temperature | **SPECULATION** | No derivation or measurement |
| Original priority claim (`d308670`) | **SPECULATION** | Not addressed by this commit |

Objections from the `96a7dcf` review resolved by this commit: the missing build configuration and the trivially `True` conclusion. Still open: thermal bounds and VFE are definitions rather than derivations.
