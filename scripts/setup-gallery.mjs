/**
 * One-time (idempotent) setup of the `gallery` orphan branch and its worktree at `gallery/`.
 * The studio calls the same code on startup; this exists so it can also be done from a terminal.
 */

import { ensureGalleryWorktree, status } from '../studio/lib/git.mjs';

const before = await status();
console.log(`当前分支 : ${before.branch ?? '(未知)'}`);
console.log(`远端     : ${before.remote ?? '(未配置)'}`);
console.log(`git 身份 : ${before.hasIdentity ? '已配置' : '未配置（将使用本地回退身份）'}`);

const { created } = await ensureGalleryWorktree();
console.log(created ? '已创建 gallery 分支和 gallery/ worktree。' : 'gallery/ worktree 已就绪，无需改动。');

const after = await status();
if (!after.remote) {
  console.log('\n还没有 origin 远端。建好 GitHub 仓库后运行：');
  console.log('  git remote add origin https://github.com/<用户名>/photos.git');
  console.log('  git push -u origin main');
}
