import { Client } from '@notionhq/client';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { config } from 'dotenv';

config();

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const DOCS_DIR = join(process.cwd(), 'docs');

async function getWorkspaceInfo() {
  const workspace = await notion.search({ page_size: 1 });
  return workspace;
}

async function createDatabase(parentPageId, title) {
  const response = await fetch('https://api.notion.com/v1/databases', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ text: { content: title } }],
      properties: {
        Name: { title: {} },
        Category: { select: { options: [] } },
        Status: { select: { options: [
          { name: 'Synced', color: 'green' },
          { name: 'Pending', color: 'yellow' },
          { name: 'Error', color: 'red' },
        ]}},
        'Last Synced': { date: {} },
        Path: { rich_text: {} },
      },
    }),
  });

  const data = await response.json();
  return data.id;
}

async function syncDocsToNotion(databaseId) {
  const files = getAllMarkdownFiles(DOCS_DIR);
  let synced = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const relativePath = relative(DOCS_DIR, file);
      const category = relativePath.split('/')[0] || 'root';
      const title = content.split('\n')[0]?.replace(/^#+\s*/, '') || relativePath;

      await notion.pages.create({
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: title } }] },
          Category: { select: { name: category } },
          Status: { select: { name: 'Synced' } },
          'Last Synced': { date: { start: new Date().toISOString() } },
          Path: { rich_text: [{ text: { content: relativePath } }] },
        },
        children: markdownToBlocks(content),
      });

      synced++;
      process.stdout.write(`\rSynced: ${synced}/${files.length} - ${relativePath}`);
    } catch (err) {
      errors++;
      console.error(`\nError syncing ${file}:`, err.message);
    }
  }

  console.log(`\n\nSync complete: ${synced} synced, ${errors} errors`);
  return { synced, errors };
}

function getAllMarkdownFiles(dir) {
  const files = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      files.push(...getAllMarkdownFiles(fullPath));
    } else if (entry.endsWith('.md')) {
      files.push(fullPath);
    }
  }

  return files;
}

function markdownToBlocks(content) {
  const blocks = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (line.startsWith('# ')) {
      blocks.push({
        object: 'block',
        type: 'heading_1',
        heading_1: { rich_text: [{ text: { content: line.slice(2) } }] },
      });
    } else if (line.startsWith('## ')) {
      blocks.push({
        object: 'block',
        type: 'heading_2',
        heading_2: { rich_text: [{ text: { content: line.slice(3) } }] },
      });
    } else if (line.startsWith('### ')) {
      blocks.push({
        object: 'block',
        type: 'heading_3',
        heading_3: { rich_text: [{ text: { content: line.slice(4) } }] },
      });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      blocks.push({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: { rich_text: [{ text: { content: line.slice(2) } }] },
      });
    } else if (line.match(/^\d+\.\s/)) {
      blocks.push({
        object: 'block',
        type: 'numbered_list_item',
        numbered_list_item: { rich_text: [{ text: { content: line.replace(/^\d+\.\s/, '') } }] },
      });
    } else if (line.startsWith('```')) {
      continue;
    } else if (line.trim()) {
      blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ text: { content: line } }] },
      });
    }
  }

  return blocks.slice(0, 100);
}

async function main() {
  console.log('Connecting to Notion workspace...');

  try {
    const workspace = await getWorkspaceInfo();
    console.log('Connected! Found', workspace.results.length, 'existing pages');

    const rootPage = workspace.results[0];
    if (!rootPage) {
      console.error('No pages found in workspace. Please create a page first.');
      process.exit(1);
    }

    console.log('Using root page:', rootPage.id);

    const docsDbId = await createDatabase(rootPage.id, 'MiniOp Documentation');
    console.log('Docs database:', docsDbId);

    console.log('\nSyncing documentation...');
    const result = await syncDocsToNotion(docsDbId);

    console.log('\nNotion sync complete!');
    console.log('Docs database ID:', docsDbId);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
