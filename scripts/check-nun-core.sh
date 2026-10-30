#!/usr/bin/env bash
# Reproduces the Civilisation.One check of github.com/bis3946/core at a given commit:
# hash parity, toolchain files, lake build with the pinned toolchain, axioms behind each theorem,
# and whether theorem 2 still holds with the thermal parameters left unconstrained.
# Needs git, sha256sum and elan (or the pinned Lean on PATH). Read-only: nothing is pushed anywhere.
set -euo pipefail
COMMIT="${1:-b0f6938}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone -q https://github.com/bis3946/core "$WORK/core"
cd "$WORK/core"
git checkout -q "$COMMIT"
echo "commit:     $(git rev-parse HEAD)"
echo "hash file:  $(cut -d' ' -f1 quantum_priority_hash.txt)"
echo "recomputed: $(sha256sum nun_quantum_proof.lean | cut -d' ' -f1)"
test -f lean-toolchain && test -f lakefile.lean && echo "toolchain:  $(cat lean-toolchain)"
echo "sorry:      $(grep -c 'sorry' nun_quantum_proof.lean || true)"
lake build
cat > Check.lean <<'LEAN'
import nun_quantum_proof
#print axioms projection_idempotent
#print axioms vfe_surplus_zero_after_projection
#print axioms vfe_pos_of_nonzero_entropy
-- Theorem 2 with kB and tempK unconstrained (no positivity): if this builds, positivity is not used.
example (st : EpistemicState) (k t : Int) :
    k * t * ((projectVerified st).s2 * (projectVerified st).s2) = 0 := by
  simp [projectVerified]
LEAN
LEAN_PATH=.lake/build/lib lake env lean Check.lean
echo "check: done"
