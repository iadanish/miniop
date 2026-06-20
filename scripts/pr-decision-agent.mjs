// PR Decision Agent
// Analyzes PR and decides: approve, request_changes, or discuss

import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function getDiff() {
  const baseSha = process.env.BASE_SHA;
  const headSha = process.env.HEAD_SHA;
  return execSync(`git diff ${baseSha}...${headSha}`, { encoding: 'utf8' });
}

async function getPRInfo() {
  const prNumber = process.env.PR_NUMBER;
  // Get PR info from GitHub API
  const response = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github.v3+json',
      },
    }
  );
  return response.json();
}

async function analyzePR(diff, prInfo) {
  const prompt = `You are a code review agent for MiniOp project. Analyze this PR and decide one of:
- approve: Safe changes, follows conventions, no issues
- request_changes: Has issues that must be fixed
- discuss: Needs human discussion or clarification

PR Title: ${prInfo.title}
PR Description: ${prInfo.body}

Diff:
${diff.substring(0, 10000)}  // Limit diff size

Consider:
1. Code quality and conventions
2. Security implications
3. Test coverage
4. Documentation updates
5. Breaking changes
6. Performance impact

Respond with JSON: { "decision": "approve|request_changes|discuss", "reason": "...", "issues": [] }`;

  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(message.content[0].text);
}

async function main() {
  try {
    const diff = await getDiff();
    const prInfo = await getPRInfo();
    const analysis = await analyzePR(diff, prInfo);
    
    console.log(JSON.stringify(analysis));
    process.exit(0);
  } catch (error) {
    console.error('Decision agent error:', error);
    console.log(JSON.stringify({ decision: 'discuss', reason: 'Agent error - needs human review', issues: [] }));
    process.exit(0);
  }
}

main();
