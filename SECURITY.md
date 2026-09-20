# Security policy

## Supported version

Security fixes are made against the latest release and the `main` branch.
Older portable builds are not maintained separately.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:

`Security` → `Advisories` → `Report a vulnerability`

Do not open a public issue for a vulnerability that could corrupt or disclose
save/catalog data before maintainers have had a chance to investigate it.

Include:

- affected version and Windows version;
- exact action taken (capture, restore, import, export, or launch);
- expected and observed behavior;
- a minimal synthetic reproduction when possible;
- whether PEPPERED or the Save Manager was running.

Do **not** upload a real `Save.es3`, catalog archive, AppData directory,
credentials, or other personal files. Replace paths and save content with
synthetic fixtures.

This is an unofficial fan tool. Reports about the PEPPERED game itself should
be sent to the game's developers, not this project.
