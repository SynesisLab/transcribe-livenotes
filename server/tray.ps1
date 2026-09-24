# Live Notes tray icon helper — packaged build only, spawned by sea-bootstrap.js.
#
# node has no notification-area support, so the exe runs this tiny WinForms
# script alongside itself: an icon in the tray (Windows files new apps under
# the hidden-icons chevron), a tooltip, a balloon on first show, and a
# right-click menu with Open / Show Logs / Quit. Quit POSTs /api/quit for a
# clean stop (the exe's exit handler takes whisper-server.exe with it) and
# only force-stops by PID if that failed. Left-click opens the app.
# "Show Logs" opens a viewer that tails data/log.txt with live updates.
#
# The icon exists only while the exe does: this process polls its parent PID
# and exits when the server goes away — crash, tray Quit or Task Manager kill.
# If no icon ever appears, run this script manually with the same arguments
# the exe uses to see the error.
param(
    [int]$Port = 3001,
    [int]$ParentPid,
    [string]$ProcessName = 'LiveNotes.exe',
    [string]$LogFile = ''
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$url = "http://127.0.0.1:$Port"
$exeName = [IO.Path]::GetFileNameWithoutExtension($ProcessName)
if (-not $LogFile) {
    # manual runs: the log sits in <root>/data/ next to this script's <root>/server/
    $LogFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'data\log.txt'
}

# ---------------------------------------------------------------------------
# Log viewer: a read-only tail of the log file, refreshed live. State is
# script-scoped so the poll timer, the form and this window outlive the click
# handler that created them (a local Timer gets garbage-collected and stops).
$script:logForm = $null
$script:logTimer = $null
$script:logOffset = -1 # -1 = never loaded; also reloaded when the file shrinks

function Update-LogView {
    # Append whatever was written to the log since the last poll. The exe
    # holds the file open for appends, so share ReadWrite.
    if (-not $script:logForm -or $script:logForm.IsDisposed) { return }
    try {
        if (-not (Test-Path $LogFile)) {
            $script:logBox.Text = "(log file not created yet: $LogFile)"
            return
        }
        $fs = [System.IO.File]::Open($LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $len = $fs.Length
            if ($len -eq $script:logOffset) { return }
            $reset = $script:logOffset -lt 0 -or $len -lt $script:logOffset
            if ($reset) {
                $fs.Position = [Math]::Max(0, $len - 262144) # first open / log rewritten: show the last 256 KB
            } else {
                $fs.Position = $script:logOffset
            }
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8, $true)
            $chunk = $sr.ReadToEnd()
            $sr.Dispose()
            $script:logOffset = $len
            if ($reset) { $script:logBox.Text = $chunk } else { $script:logBox.AppendText($chunk) }
            $script:logBox.SelectionStart = $script:logBox.TextLength # follow the tail
            $script:logBox.ScrollToCaret()
        } finally { $fs.Dispose() }
    } catch { }
}

function Show-LogWindow {
    if (-not $script:logForm -or $script:logForm.IsDisposed) {
        $script:logOffset = -1
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'Live Notes - Log'
        $form.Size = New-Object System.Drawing.Size(860, 560)
        $form.MinimumSize = New-Object System.Drawing.Size(520, 320)
        $form.StartPosition = 'CenterScreen'
        $form.Icon = $icon
        $form.Font = New-Object System.Drawing.Font('Consolas', 9)
        $box = New-Object System.Windows.Forms.TextBox
        $box.Multiline = $true
        $box.ReadOnly = $true
        $box.ScrollBars = 'Both'
        $box.WordWrap = $false
        $box.HideSelection = $false # keep the selection visible when unfocused
        $box.Dock = 'Fill'
        $box.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27)
        $box.ForeColor = [System.Drawing.Color]::FromArgb(228, 228, 231)
        $form.Controls.Add($box)
        $script:logBox = $box
        $script:logForm = $form

        $timer = New-Object System.Windows.Forms.Timer
        $timer.Interval = 500
        $timer.add_Tick({ Update-LogView })
        $timer.Start()
        $script:logTimer = $timer # keep it alive: an unreferenced Timer gets collected and stops

        $form.add_FormClosed({ $script:logTimer.Stop() })
        $form.Show()
        Update-LogView
    } else {
        $script:logForm.Show()
        $script:logForm.Activate()
    }
}

# ---------------------------------------------------------------------------
# Icon: warm-orange round tile with a white "L" (the app's accent color).
$bmp = New-Object System.Drawing.Bitmap(32, 32)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.FillEllipse(
    [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 217, 119, 87)),
    1, 1, 30, 30
)
$g.DrawString('L', [System.Drawing.Font]::new('Segoe UI', 13, [System.Drawing.FontStyle]::Bold), [System.Drawing.Brushes]::White, 10, 5)
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())

$tray = [System.Windows.Forms.NotifyIcon]::new()
$tray.Icon = $icon
$tray.Text = "Live Notes - $url"
$tray.Visible = $true
$tray.ShowBalloonTip(
    5000,
    'Live Notes',
    "Notes are running at $url (right-click this icon to quit).",
    [System.Windows.Forms.ToolTipIcon]::Info
)

# Right-click menu.
$menu = [System.Windows.Forms.ContextMenuStrip]::new()
$open = [System.Windows.Forms.ToolStripMenuItem]::new('Open Live Notes')
$open.add_Click({ Start-Process $url })
[void]$menu.Items.Add($open)
$showLogs = [System.Windows.Forms.ToolStripMenuItem]::new('Show Logs')
$showLogs.add_Click({ Show-LogWindow })
[void]$menu.Items.Add($showLogs)
[void]$menu.Items.Add([System.Windows.Forms.ToolStripSeparator]::new())
$quit = [System.Windows.Forms.ToolStripMenuItem]::new('Quit')
$quit.add_Click({
    try { Invoke-RestMethod -Method Post -Uri "$url/api/quit" -TimeoutSec 5 | Out-Null } catch {}
    # Normally the POST is enough; if the server is wedged, stop it by PID.
    $deadline = (Get-Date).AddSeconds(6)
    while ((Get-Date) -lt $deadline -and (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 250
    }
    Get-Process -Name $exeName -ErrorAction SilentlyContinue |
        Where-Object { $_.Id -eq $ParentPid } |
        Stop-Process -Force
    $timer.Stop()
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
[void]$menu.Items.Add($quit)
$tray.ContextMenuStrip = $menu

# Left-click opens the app in the browser.
$tray.add_MouseUp({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $url }
})

# The icon lives only while the exe does — poll its PID.
$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 2000
$timer.add_Tick({
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        $timer.Stop()
        $tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    }
})
$timer.Start()

[void][System.Windows.Forms.Application]::Run()
$tray.Dispose()