import { Client } from '@notionhq/client';
import { config } from 'dotenv';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const LOGS_DIR = join(process.cwd(), 'logs');
if (!existsSync(LOGS_DIR)) {
  mkdirSync(LOGS_DIR, { recursive: true });
}

class NotionMCP {
  constructor() {
    this.logsDbId = null;
    this.agentsDbId = null;
    this.loopsDbId = null;
  }

  async initialize(rootPageId) {
    this.logsDbId = await this.findOrCreateDb(rootPageId, 'Agent Logs', [
      { name: 'Timestamp', type: 'date' },
      { name: 'Agent', type: 'select' },
      { name: 'Action', type: 'select' },
      { name: 'Status', type: 'select' },
      { name: 'Details', type: 'rich_text' },
    ]);

    this.agentsDbId = await this.findOrCreateDb(rootPageId, 'Agent Status', [
      { name: 'Agent Name', type: 'title' },
      { name: 'Status', type: 'select' },
      { name: 'Last Active', type: 'date' },
      { name: 'Tasks Completed', type: 'number' },
      { name: 'Error Rate', type: 'number' },
    ]);

    this.loopsDbId = await this.findOrCreateDb(rootPageId, 'Feedback Loops', [
      { name: 'Loop Name', type: 'title' },
      { name: 'Status', type: 'select' },
      { name: 'Last Run', type: 'date' },
      { name: 'Success Rate', type: 'number' },
      { name: 'Conflicts', type: 'number' },
    ]);

    console.log('MCP initialized:');
    console.log('  Logs DB:', this.logsDbId);
    console.log('  Agents DB:', this.agentsDbId);
    console.log('  Loops DB:', this.loopsDbId);
  }

  async findOrCreateDb(parentPageId, title, properties) {
    const existing = await notion.search({
      query: title,
    });

    const databases = existing.results.filter(r => r.object === 'database');
    if (databases.length > 0) {
      return databases[0].id;
    }

    const props = {};
    for (const prop of properties) {
      if (prop.type === 'title') {
        props[prop.name] = { title: {} };
      } else if (prop.type === 'select') {
        props[prop.name] = { select: { options: [] } };
      } else if (prop.type === 'date') {
        props[prop.name] = { date: {} };
      } else if (prop.type === 'number') {
        props[prop.name] = { number: {} };
      } else if (prop.type === 'rich_text') {
        props[prop.name] = { rich_text: {} };
      }
    }

    const db = await notion.databases.create({
      parent: { page_id: parentPageId },
      title: [{ text: { content: title } }],
      properties: props,
    });

    return db.id;
  }

  async logAgentActivity(agentName, action, status, details) {
    if (!this.logsDbId) {
      console.error('MCP not initialized. Call initialize() first.');
      return;
    }

    await notion.pages.create({
      parent: { database_id: this.logsDbId },
      properties: {
        Timestamp: { date: { start: new Date().toISOString() } },
        Agent: { select: { name: agentName } },
        Action: { select: { name: action } },
        Status: { select: { name: status } },
        Details: { rich_text: [{ text: { content: details || '' } }] },
      },
    });

    this.writeLocalLog(agentName, action, status, details);
  }

  async updateAgentStatus(agentName, status, tasksCompleted, errorRate) {
    if (!this.agentsDbId) return;

    const existing = await notion.search({
      query: agentName,
      filter: { property: 'object', value: 'database' },
    });

    const pages = await notion.databases.query({
      database_id: this.agentsDbId,
      filter: {
        property: 'Agent Name',
        title: { equals: agentName },
      },
    });

    if (pages.results.length > 0) {
      await notion.pages.update({
        page_id: pages.results[0].id,
        properties: {
          Status: { select: { name: status } },
          'Last Active': { date: { start: new Date().toISOString() } },
          'Tasks Completed': { number: tasksCompleted },
          'Error Rate': { number: errorRate },
        },
      });
    } else {
      await notion.pages.create({
        parent: { database_id: this.agentsDbId },
        properties: {
          'Agent Name': { title: [{ text: { content: agentName } }] },
          Status: { select: { name: status } },
          'Last Active': { date: { start: new Date().toISOString() } },
          'Tasks Completed': { number: tasksCompleted },
          'Error Rate': { number: errorRate },
        },
      });
    }
  }

  async logLoopStatus(loopName, status, successRate, conflicts) {
    if (!this.loopsDbId) return;

    const pages = await notion.databases.query({
      database_id: this.loopsDbId,
      filter: {
        property: 'Loop Name',
        title: { equals: loopName },
      },
    });

    if (pages.results.length > 0) {
      await notion.pages.update({
        page_id: pages.results[0].id,
        properties: {
          Status: { select: { name: status } },
          'Last Run': { date: { start: new Date().toISOString() } },
          'Success Rate': { number: successRate },
          Conflicts: { number: conflicts },
        },
      });
    } else {
      await notion.pages.create({
        parent: { database_id: this.loopsDbId },
        properties: {
          'Loop Name': { title: [{ text: { content: loopName } }] },
          Status: { select: { name: status } },
          'Last Run': { date: { start: new Date().toISOString() } },
          'Success Rate': { number: successRate },
          Conflicts: { number: conflicts },
        },
      });
    }
  }

  writeLocalLog(agent, action, status, details) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${agent} | ${action} | ${status} | ${details || ''}\n`;
    appendFileSync(join(LOGS_DIR, 'agent-activity.log'), logLine);
  }
}

export default NotionMCP;
