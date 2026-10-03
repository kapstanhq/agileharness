# Security policy

This is the **policy**: what's in scope, how to report, what to expect and how fast. The **technical
posture** — trust model, what per-run containment covers and what it doesn't, how to revoke a
credential, the checklist before exposing beyond `localhost` — lives in
[`packages/storymap-ui/SECURITY.md`](packages/storymap-ui/SECURITY.md), and the measured risk
inventory in [`packages/storymap-ui/docs/threat-model.md`](packages/storymap-ui/docs/threat-model.md).
Nothing from either is repeated here, on purpose: two documents saying the same thing drift apart, and
what rots is always the summary.

## Before you report: what is the product, and not a bug

These four capabilities are **declared** — anyone reporting them as a flaw would be describing the
tool, not a vulnerability in it:

- it spawns agents with the CLI's permission prompt **turned off**, and they edit code and can publish;
- those processes inherit the service's user (`root`, in the reference installation);
- there is a shell served over **WebSocket**, behind the same gate as the panel;
- the model is **single-operator**: there are no roles and no RBAC, and whoever holds the credential
  holds the machine.

What is protected is the **perimeter**. So, in scope:

- reaching any of those capabilities **without the operator's credential** — the session gate, the
  cookie, the WebSocket `Origin` check, the MCP endpoint;
- turning content the board **ingests** into a command (a card, a sidecar, a diff, agent output,
  free-text capture) — this is the highest declared risk class, and the one most likely to produce a
  real report;
- **escaping a run's containment**: a write outside the envelope, egress to an undeclared host,
  reading a path the deny list names. Check first that containment actually came up: without
  `bubblewrap` and `socat` installed, the default **downgrades** the run, and you would be testing a
  posture the product doesn't recommend rather than finding a hole in the one it does;
- **credential leakage** — a token in a log, in a URL, or readable by an unprivileged user;
- **silent downgrade**: any protection that should refuse and instead passes without warning.

Out of scope, with the reasons written down, in the *"Fora de escopo (e por que)"* section of
[`packages/storymap-ui/SECURITY.md`](packages/storymap-ui/SECURITY.md).

## How to report

Use **GitHub's private vulnerability reporting** — the **Security → Advisories → Report a
vulnerability** tab. It is private by construction, it doesn't ask you to trust an address published
on a page, and it is the channel that **is enabled** on this repository.

**Do not open a public issue** for an exploitable flaw. A compromised board is arbitrary execution on
the machine running it: the window between a public report and a patch is the attack.

**There is no published contact email, and the absence is the decision.** Private reporting delivers
the report to whoever answers for the repository with no intermediary; a published address that nobody
reads is worse than no address at all — the researcher believes they warned someone, and the report
goes nowhere.

What helps most, in the body of the report: the version or commit; whether the service sat behind a
reverse proxy; the values of `AGILEHARNESS_HOST` and `AGILEHARNESS_DEV`; and whether the path goes
through content the board ingests.

## What to expect

- **No SLA.** The project is maintained by one operator. The target is to answer in days, not weeks,
  and there is no contractual promise — saying otherwise would invent a commitment nobody signed.
- **14 days of silence ⇒ assume unavailability** and escalate however you prefer, including
  coordinated disclosure with a deadline. You should not be held hostage by an inbox that doesn't
  answer.
- **No bounty program**, no hall of fame, no outsourced triage. Credit in the advisory, under whatever
  name you choose, if you want it.
- The fix ships as a **published advisory + a commit on `main`**. There is no maintenance line where
  it could be applied quietly.

## Supported versions

| Version | Supported |
|---|---|
| `main` HEAD | yes |
| any earlier commit | no |

There are no backports. What that demands of your installation — and why one that cannot update falls
outside the supported threat model — is in
[`packages/storymap-ui/SECURITY.md`](packages/storymap-ui/SECURITY.md).
