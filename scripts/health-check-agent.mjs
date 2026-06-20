// Health Check Agent
// Runs comprehensive repository health check

import { execSync } from 'child_process';
import { readFile, readdir } from 'fs/promises';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function getRepoStats() {
  const stats = {};
  
  // Count files by type
  const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
  stats.totalFiles = files.length;
  stats.byType = {};
  for (const file of files) {
    const ext = file.split('.').pop() || 'no-ext';
    stats.byType[ext] = (stats.byType[ext] || 0) + 1;
  }
  
  // Count commits
  stats.totalCommits = parseInt(execSync('git rev-list --count HEAD', { encoding: 'utf8' }));
  
  // Count branches
  stats.branches = execSync('git branch -r', { encoding: 'utf8' }).split('\n').filter(Boolean).length;
  
  // Count open issues (would need GitHub API)
  stats.openIssues = 'Check GitHub';
  
  // Count PRs
  stats.openPRs = 'Check GitHub';
  
  return stats;
}

async function checkDocumentation() {
  const docsDir = 'docs';
  try {
    const files = await readdir(docsDir, { recursive: true });
    const mdFiles = files.filter(f => f.endsWith('.md'));
    return {
      total: mdFiles.length,
      categories: [...new Set(mdFiles.map(f => f.split('/')[0]))].length,
    };
  } catch {
    return { total: 0, categories: 0 };
  }
}

async function checkTests() {
  const testDirs = ['frontend/tests', 'backend/tests', 'worker/tests'];
  const results = {};
  
  for (const dir of testDirs) {
    try {
      const files = await readdir(dir, { recursive: true });
      results[dir] = files.filter(f => f.endsWith('.test.ts') || f.endsWith('.test.js')).length;
    } catch {
      results[dir] = 0;
    }
  }
  
  return results;
}

async function generateReport(stats, docs, tests) {
  const prompt = `Generate a health report for MiniOp repository:

Repository Stats:
- Total files: ${stats.totalFiles}
- Total commits: ${stats.totalCommits}
- Branches: ${stats.branches}
- File types: ${JSON.stringify(stats.byType)}

Documentation:
- Total docs: ${docs.total}
- Categories: ${docs.categories}

Tests:
- Frontend tests: ${tests['frontend/tests']}
- Backend tests: ${tests['backend/tests']}
- Worker tests: ${tests['worker/tests']}

Generate a markdown report with:
1. Overall health score (1-10)
2. Strengths
3. Areas for improvement
4. Recommendations
5. Action items

Format as markdown.`;

  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

async function main() {
  try {
    const stats = await getRepoStats();
    const docs = await checkDocumentation();
    const tests = await checkTests();
    const report = await generateReport(stats, docs, tests);
    
    console.log(report);
    process.exit(0);
  } catch (error) {
    console.error('Health check error:', error);
    console.log('## Health Check Failed\n\nError running health check agent. Manual review needed.');
    process.exit(0);
  }
}

main();
