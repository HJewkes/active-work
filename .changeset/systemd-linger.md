---
'@hjewkes/active-work': patch
---

AW-1: `active-work setup` now enables systemd **lingering** for the daemon on
Linux, so it survives logout and starts at boot. Previously the user unit was
installed with `systemctl --user enable --now`, which keeps the daemon up only
while the user is logged in — at logout the user manager (and the daemon) were
torn down.

`stepInstallSupervision` now runs `loginctl enable-linger <user>` (best-effort).
It uses the explicit-username form because the bare form errors ("No such
device") outside a login session, and it routes through polkit's
`set-self-linger` when the target is the caller. If lingering can't be enabled
without privileges, setup does not fail — it prints a copy-pasteable
`sudo loginctl enable-linger <user>` note instead.

Verified end-to-end in an Ubuntu 24.04 / systemd 255 container: install →
`setup` → unit active & serving → restart-on-crash → uninstall, plus confirming
that without lingering the daemon dies on session loss and recovers once it is
enabled.
