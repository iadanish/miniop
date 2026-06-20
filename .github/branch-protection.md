name: Branch Protection Rules

# This file documents the branch protection rules that should be configured
# in GitHub repository settings. These rules enforce code quality and security.

# To apply these rules, go to:
# https://github.com/iadanish/miniop/settings/branches

# Main Branch Protection Rules:
# 1. Require pull request reviews before merging
#    - Required approving reviews: 1
#    - Dismiss stale PR approvals when new commits are pushed
#    - Require review from code owners
#
# 2. Require status checks to pass before merging
#    - Required checks:
#      - Frontend Tests
#      - Backend Tests
#      - Worker Tests
#      - Security Scan
#      - E2E Tests
#      - Benchmark Checks
#
# 3. Require branches to be up to date before merging
#
# 4. Require linear history (no merge commits)
#
# 5. Include administrators in restrictions
#
# 6. Allow force pushes: No
#
# 7. Allow deletions: No

# CODEOWNERS file should be created at .github/CODEOWNERS
# Example:
# * @iadanish
# /frontend/ @iadanish
# /backend/ @iadanish
# /worker/ @iadanish
# /.github/ @iadanish
# /docs/ @iadanish
