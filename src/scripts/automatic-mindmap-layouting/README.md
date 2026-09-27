# Automatic Mindmap Layouting

This script is part of the scientific research project [Simulierte Wirklichkeit](https://github.com/BOGYLI/simulierte-wirklichkeit/tree/nikolas/projects/nikolas). Refer to the main repository for the full project description, including the research paper and simulation environment.

Please link the "simulation/src/core" folder from the main repository of the project to "core" in this folder with a symbolic link. This is necessary for building the script.

The symbolic link can be created with the following command in a terminal (Linux or macOS):
```bash
ln -s /PATHTOPROJECT/simulierte-wirklichkeit/projects/nikolas/simulation/src/core core
```

An example of how to do this in PowerShell (Administrator) is:
```powershell
New-Item -ItemType SymbolicLink -Path "C:\PATHTOPROJECT\ObsidianExcalidrawAutomate\src\scripts\automatic-mindmap-layouting\core" -Value "C:\PATHTOPROJECT\simulierte-wirklichkeit\projects\nikolas\simulation\src\core"
```
