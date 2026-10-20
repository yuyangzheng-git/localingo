# LocaLingo deployment

- Project checkout: `/Users/yuyangzheng/project/localingo`.
- Production website: `http://101.35.6.63/`.
- SSH host: `101.35.6.63`; user: `ubuntu`.
- The remote checkout directory and deployment mechanism must be verified on the server before updating it.
- Inspect remote Git status and running services first; preserve local changes, deployment configuration, and persistent data.
- After deployment, verify the homepage, its stylesheet, the learning center, and `/api/health`.
- Never store passwords, private keys, or tokens in repository files, commits, or logs. Obtain credentials through a secure channel or use SSH keys.
- Commit local changes. Push or deploy only when requested by the user.
