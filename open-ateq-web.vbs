Option Explicit

Dim shell, fso, scriptDir, startupScript, command, result

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
startupScript = fso.BuildPath(scriptDir, "start.cmd")

If Not fso.FileExists(startupScript) Then
    MsgBox "Cannot find start.cmd in:" & vbCrLf & scriptDir, vbCritical, "ATEQ Test D520"
    WScript.Quit 1
End If

command = "cmd.exe /c " & Quote(startupScript)
result = shell.Run(command, 0, True)

If result <> 0 Then
    MsgBox "ATEQ service failed to start. Please check server.out / server.err.", vbCritical, "ATEQ Test D520"
    WScript.Quit result
End If

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
