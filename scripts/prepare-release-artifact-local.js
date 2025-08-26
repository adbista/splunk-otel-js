const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { Octokit } = require('octokit');

const { version } = require('../package.json');

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;

const PUBLIC_ARTIFACTS_TOKEN = process.env.PUBLIC_ARTIFACTS_TOKEN ?? 'NOT_SET';
console.log(`Using PUBLIC_ARTIFACTS_TOKEN: ${PUBLIC_ARTIFACTS_TOKEN}`);
const GITHUB_OWNER = 'adbista'; 
const GITHUB_REPO = 'splunk-otel-js'; 

// hash of the last commit. Used for artefact retrieval;
// how to properly check it on my fork? 
// 1. Create a new branch based on "feat/add-esbuild-plugin", perhaps named something like "test/ci-scripts-esbuild-plugin"
// 2. Remove proper lines in ci.yml 
// 3. create dummy commits and push to forked repo
// for entire hash: git log --format="%H" -n 1
// for description of last commit: git log --oneline -n 1
// commit message: "..."
const CI_COMMIT_SHA = '82ee940950cf61a588d64a521537a47d247f70a5';
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWorkflowRun(context) {
  const { data: workflows } = await context.octokit.rest.actions.listWorkflowRunsForRepo({
    owner: context.owner,
    repo: context.repo,
  });

  const runs = workflows.workflow_runs;
// add commit sha 
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

async function downloadArtifact(octokit, owner, repo, runId, artifactName) {
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

function extractAndVerifyArtifact(artifact, targetFile) {
  const tempFile = 'artifact-temp.zip';
  console.log(`writing content to ${tempFile} and unzipping`);
  fs.writeFileSync(tempFile, Buffer.from(artifact.data));
  execSync(`unzip -o ${tempFile}`);

  const exists = fs.existsSync(targetFile);
  console.log(`${targetFile} was extracted: ${exists}`);
  
  if (!exists) {
    throw new Error(`Target file ${targetFile} was not found after extraction`);
  }

  fs.unlinkSync(tempFile);
  return targetFile;
}

async function getBuildArtifact() {
  const packageArg = process.argv.find(arg => arg.startsWith('--package='));
  if (!packageArg) {
    throw new Error('Missing --package=filename.tgz argument');
  }
  const targetFileName = packageArg.split('=')[1]; 
  console.log(`Target file: ${targetFileName}`);

  const octokit = new Octokit({ auth: PUBLIC_ARTIFACTS_TOKEN });
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;

  console.log('waiting for workflow results');

  const run = await waitForWorkflowRun({ octokit, owner, repo });  

  console.log('found finished workflow run', run);

  const tgzName = `splunk-otel-${version}.tgz`;
  
  if (targetFileName === tgzName) {
    // Download and extract main package artifact
    const splunkOtelArtifact = await downloadArtifact(octokit, owner, repo, run.id, tgzName);

    return extractAndVerifyArtifact(splunkOtelArtifact, targetFileName);
  } else {
    // Download and extract workspace packages artifact which contains all workspace packages
    const workspacePackageName = 'workspace-packages';
    const workspaceArtifact = await downloadArtifact(octokit, owner, repo, run.id, workspacePackageName);

    return extractAndVerifyArtifact(workspaceArtifact, targetFileName);
  }
}

async function prepareReleaseArtifact() {
  const artifactName = await getBuildArtifact();

  fs.mkdirSync('dist', { recursive: true });
  fs.renameSync(artifactName, path.join('dist', artifactName));

  console.log('successfully prepared artifacts');
}

prepareReleaseArtifact().catch(e => {
  console.error(e);
  process.exit(1);
});
