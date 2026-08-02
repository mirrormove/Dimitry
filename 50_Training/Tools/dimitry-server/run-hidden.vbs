' Launches the Dimitry server with NO visible console window (used by auto-start).
' Absolute path is baked in so this works even when this file is copied into the
' Windows Startup folder. The previous version derived its own folder and, once in
' Startup, looked for start-dimitry.bat inside Startup (which does not exist) -> WSH 80070002.
Dim fso, sh, serverDir, bat
Set fso = CreateObject("Scripting.FileSystemObject")

serverDir = "C:\Users\Jesus\Downloads\Trading\50_Training\Tools\dimitry-server"
bat = serverDir & "\start-dimitry.bat"

' Fallback: if the vault folder was moved, use the folder this script actually lives in.
If Not fso.FileExists(bat) Then
  serverDir = fso.GetParentFolderName(WScript.ScriptFullName)
  bat = serverDir & "\start-dimitry.bat"
End If

If fso.FileExists(bat) Then
  Set sh = CreateObject("WScript.Shell")
  sh.CurrentDirectory = serverDir
  sh.Run """" & bat & """", 0, False
End If
