' Molly hidden launcher.
' Runs a command with no console window (WScript.Run window style 0).
' Used by Task Scheduler task "MollyCmdAgent" once per minute so no black box flashes.
' Keep this file ASCII-only: wscript reads .vbs as ANSI, non-ASCII bytes break parsing.
Option Explicit
Dim TARGET, sh
TARGET = "${MOLLY_ROOT}\qq-whale\tools\cmd-agent-once.cmd"
Set sh = CreateObject("WScript.Shell")
' 0 = hidden window, False = do not wait
sh.Run "cmd.exe /c """ & TARGET & """", 0, False
