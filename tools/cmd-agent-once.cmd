@echo off
chcp 65001 >nul
rem Molly cmd-mailbox poller: run one round then exit.
rem Called every minute by Task Scheduler task "MollyCmdAgent" via run-hidden.vbs (no console window).
rem stdout is discarded (cmd-agent writes its own out\cmd-agent.log); stderr goes to dbg log.
"${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "${MOLLY_ROOT}\qq-whale\tools\cmd-agent.mjs" --once 1>nul 2>>"${MOLLY_ROOT}\qq-whale\out\cmd-agent.dbg.log"
