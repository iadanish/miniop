// Issue Decision Agent
// Analyzes issues and decides: close, label, assign, or discuss

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

async function analyzeIssue(title, body) {
  const prompt = `You are an issue triage agent for MiniOp project. Analyze this issue and decide one of:
- close: Invalid, duplicate, out of scope, or not actionable
- label: Needs categorization (add labels)
- assign: Needs human review
- discuss: Needs clarification from reporter

Issue Title: ${title}
Issue Body: ${body}

Consider:
1. Is the issue clear and actionable?
2. Is it a duplicate of existing issues?
3. Is it within project scope?
4. Does it need more information?
5. Is it a bug, feature request, or question?

Respond with JSON: { "decision": "close|label|assign|discuss", "reason": "...", "labels": ["label1", "label2"] }`;

  const message = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(message.content[0].text);
}

async function main() {
  try {
    const title = process.env.ISSUE_TITLE;
    const body = process.env.ISSUE_BODY;
    const analysis = await analyzeIssue(title, body);
    
    console.log(JSON.stringify(analysis));
    process.exit(0);
  } catch (error) {
    console.error('Issue decision agent error:', error);
    console.log(JSON.stringify({ decision: 'assign', reason: 'Agent error - needs human review', labels: [] }));
    process.exit(0);
  }
}

main();
