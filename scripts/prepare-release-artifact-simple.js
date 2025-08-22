const fs = require('fs');
const { execSync } = require('child_process');
const { Octokit } = require('octokit');

const { version } = require('../package.json');

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;

const PUBLIC_ARTIFACTS_TOKEN = process.env.PUBLIC_ARTIFACTS_TOKEN ?? 'NOT_SET';
console.log(`Using PUBLIC_ARTIFACTS_TOKEN: ${PUBLIC_ARTIFACTS_TOKEN}`);
const GITHUB_OWNER = 'adbista'; 
const GITHUB_REPO = 'splunk-otel-js'; 

const CI_COMMIT_SHA = '5c3db0cb248282feeb0f05e4d9fc14aa3d4689a4'; 

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWorkflowRun(context) {
  const { data: workflows } = await context.octokit.rest.actions.listWorkflowRunsForRepo({
    owner: context.owner,
    repo: context.repo,
  });

  const runs = workflows.workflow_runs;
  const commitSha = CI_COMMIT_SHA;
  const run = runs.find(wf => wf.head_sha === commitSha && wf.name.toLowerCase() === 'continuous integration');

  if (run === undefined) {
    throw new Error(`Workflow not found for commit ${commitSha}`);
  }

  return run;
}

async function waitForWorkflowRun(context) {
  const waitUntil = Date.now() + WORKFLOW_TIMEOUT_MS;

  for (;;) {
    let run = await fetchWorkflowRun(context);

    if (run.status !== 'completed') {
      if (Date.now() > waitUntil) {
        throw new Error('Timed out waiting for workflow to finish');
      }

      console.log('run not yet completed, waiting...');
      await sleep(10_000);
      continue;
    }

    if (run.status === 'completed' && run.conclusion !== 'success') {
      throw new Error(`Workflow not successful conclusion=${run.conclusion}`);
    }

    return run;
  }
}

async function downloadArtifact({ octokit, owner, repo, runId, artifactName }) {
  const { data: artifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: runId,
    name: artifactName,
  });

  const artifact = artifacts.artifacts.find(artifact => artifact.name === artifactName);
  
  if (artifact === undefined) {
    throw new Error(`unable to find artifact named ${artifactName}`);
  }

  const downloadedArtifact = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: artifact.id,
    archive_format: 'zip',
  });
  
  return {
    name: artifact.name,
    data: downloadedArtifact.data
  };
}

async function prepareReleaseArtifact() {
  const octokit = new Octokit({ auth: PUBLIC_ARTIFACTS_TOKEN });
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;

  console.log('waiting for workflow results');
  const run = await waitForWorkflowRun({ octokit, owner, repo });  
  console.log('found finished workflow run', run);

  const tgzName = `splunk-otel-${version}.tgz`;
  const workspacePackageName = `workspace-packages`;

  // Download artifacts
  const splunkOtelArtifact = await downloadArtifact({ 
    octokit, 
    owner, 
    repo, 
    runId: run.id, 
    artifactName: tgzName 
  });
  
  const workspaceArtifact = await downloadArtifact({ 
    octokit, 
    owner, 
    repo, 
    runId: run.id, 
    artifactName: workspacePackageName 
  });

  console.log('downloaded artifacts successfully');

  // Create dist directory
  fs.mkdirSync('dist', { recursive: true });

  // Extract main splunk-otel package directly to dist
  const splunkTempFile = 'splunk-temp.zip';
  fs.writeFileSync(splunkTempFile, Buffer.from(splunkOtelArtifact.data));
  console.log(`Extracting ${splunkOtelArtifact.name} to dist/`);
  execSync(`unzip -o ${splunkTempFile} -d dist`);
  fs.unlinkSync(splunkTempFile);

  // Extract workspace packages directly to dist  
  const workspaceTempFile = 'workspace-temp.zip';
  fs.writeFileSync(workspaceTempFile, Buffer.from(workspaceArtifact.data));
  console.log(`Extracting workspace packages to dist/`);
  execSync(`unzip -o ${workspaceTempFile} -d dist`);
  fs.unlinkSync(workspaceTempFile);

  // List what we extracted
  const distFiles = fs.readdirSync('dist').filter(file => file.endsWith('.tgz'));
  console.log('Successfully prepared artifacts:');
  distFiles.forEach(file => console.log(`  - dist/${file}`));

  if (distFiles.length === 0) {
    throw new Error('No .tgz files found in dist directory');
  }

  console.log('All artifacts prepared successfully!');
}

prepareReleaseArtifact().catch(e => {
  console.error(e);
  process.exit(1);
});
