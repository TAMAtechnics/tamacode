// 自動生成: scripts/build-rules.mjs が rules/security.json から作る。直接編集しない。
export const RULES_DEFAULTS: Record<string, unknown> = {
  "exclude": [
    "node_modules/",
    ".tama-backup/",
    "tests/",
    "docs/",
    ".git/",
    "dist/",
    "build/",
    ".next/",
    "coverage/"
  ],
  "excludeFiles": [
    ".env.example",
    ".env.sample",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb"
  ],
  "secretPatterns": [
    "\\bsk-[A-Za-z0-9_-]{16,}",
    "\\bAKIA[0-9A-Z]{12,}",
    "\\bgh[pousr]_[A-Za-z0-9]{20,}",
    "\\beyJ[A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{10,}",
    "(?<![A-Za-z0-9/+=_.-])(?=[A-Za-z0-9]*[0-9])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{32,}(?![A-Za-z0-9/+=_.-])"
  ],
  "secretAllowContext": [
    "process\\.env\\.",
    "import\\.meta\\.env\\.",
    "\\$\\{",
    "example",
    "EXAMPLE",
    "your[-_ ]?api[-_ ]?key",
    "xxxx",
    "\\.\\.\\."
  ],
  "secretFiles": [
    "^\\.env$",
    "^\\.env\\..+$",
    "\\.pem$",
    "\\.key$",
    "^credentials\\.json$",
    "^service-account.*\\.json$"
  ],
  "secretFilesExcept": [
    "^\\.env\\.example$",
    "^\\.env\\.sample$",
    "^\\.env\\.template$"
  ],
  "clientDirs": [
    "app/",
    "components/",
    "pages/",
    "public/",
    "src/app/",
    "src/components/",
    "src/pages/"
  ],
  "serviceRoleWords": [
    "service_role",
    "SUPABASE_SERVICE_ROLE_KEY"
  ],
  "publicRepoPatterns": [
    "\\bgh\\s+repo\\s+create\\b[^|;&]*--public\\b",
    "\\bgit\\s+remote\\s+add\\b[^|;&]*\\bpublic\\b"
  ],
  "prodMarkers": [
    "\\.env\\.production",
    "--prod\\b",
    "\\bproduction\\b",
    "\\bprod\\b",
    "\\bmain\\b.*--force"
  ],
  "prodProjectIds": [],
  "destructivePatterns": [
    "\\bdrop\\s+(table|database|schema)\\b",
    "\\bdelete\\s+from\\b",
    "\\bdb\\s+reset\\b",
    "\\breset\\s+--hard\\b",
    "\\btruncate\\b",
    "\\brm\\s+-rf?\\b"
  ],
  "migrationsDirs": [
    "supabase/migrations/",
    "prisma/migrations/",
    "migrations/"
  ],
  "apiRoutePattern": "(^|/)app/api/.*/route\\.(ts|tsx|js|mjs)$",
  "serverActionMarker": "[\"']use server[\"']",
  "adminPattern": "(^|/)admin(/|\\.|-|_|$)",
  "authWords": [
    "auth",
    "getUser",
    "getSession",
    "session",
    "currentUser",
    "requireUser",
    "verifyToken"
  ],
  "logPattern": "\\b(console\\.(log|info|debug|warn|error)|logger\\.(log|info|debug|warn|error))\\s*\\(",
  "piiWords": [
    "email",
    "phone",
    "address",
    "password",
    "passwd",
    "token",
    "creditcard",
    "card_number"
  ],
  "installPatterns": [
    "\\b(npm|pnpm)\\s+(i|install|add)\\b",
    "\\byarn\\s+(add|install)\\b"
  ],
  "scanMaxFiles": 400,
  "scanMaxBytes": 200000,
  "scanTextExtensions": [
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "json",
    "sql",
    "env",
    "md",
    "yml",
    "yaml",
    "toml",
    "py",
    "rb",
    "go",
    "rs",
    "php",
    "html",
    "vue",
    "svelte",
    "prisma",
    "sh",
    "txt"
  ]
};
