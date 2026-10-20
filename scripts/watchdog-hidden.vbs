' 计划任务入口：以隐藏窗口运行生产看门狗，避免每分钟闪出控制台窗口。
' 由 "Zane Workbench Watchdog" 计划任务调用；参数与 scripts/watch-production.mjs 保持一致。
' 等待子进程结束（waitOnReturn=True），使任务原有的 ExecutionTimeLimit 仍能兜底终止卡住的看门狗。
Option Explicit

Dim shell, fso, projectRoot, nodeExe, watchdogScript, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
watchdogScript = projectRoot & "\scripts\watch-production.mjs"

If Not fso.FileExists(nodeExe) Then
  WScript.Quit 1
End If
If Not fso.FileExists(watchdogScript) Then
  WScript.Quit 1
End If

shell.CurrentDirectory = projectRoot
commandLine = """" & nodeExe & """ """ & watchdogScript & """"
' 0 = 隐藏窗口；True = 等待退出码，让计划任务的 2 分钟上限继续生效。
WScript.Quit shell.Run(commandLine, 0, True)
