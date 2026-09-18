Set-Location "C:\Users\PC\career-ops"
$prompt = Get-Content -Raw -Path "websearch-scan-prompt.md"
$allowedTools = "Read,Glob,Grep,WebSearch,WebFetch,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_close"
$resultsPath = "C:\Users\PC\career-ops\websearch-scan-results.txt"

# Plain stdout redirection -- not a Claude tool call, so it isn't subject to
# the tool-permission system. This is the write path for an otherwise
# read-only headless run: it prints, the shell captures it to a file.
& "C:\Users\PC\AppData\Roaming\npm\claude.cmd" -p $prompt --allowedTools $allowedTools --permission-prompts none *> $resultsPath

# Deterministic script, no AI involved -- does the actual write/commit.
node "C:\Users\PC\career-ops\apply-websearch-results.mjs" $resultsPath
