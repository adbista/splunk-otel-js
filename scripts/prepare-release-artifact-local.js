const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { Octokit } = require('octokit');
const util = require('util'); 

const { version } = require('../package.json');

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;

const PUBLIC_ARTIFACTS_TOKEN = process.env.PUBLIC_ARTIFACTS_TOKEN ?? 'NOT_SET';
console.log(`Using PUBLIC_ARTIFACTS_TOKEN: ${PUBLIC_ARTIFACTS_TOKEN}`);
const GITHUB_OWNER = 'adbista'; 
const GITHUB_REPO = 'splunk-otel-js'; 

// hash of the last commit. Used for artefact retrieval;
// how to properly check it on my fork? 
// 1. Create a new branch based on "feat/add-esbuild-plugin", perhaps named something like "test/ci-scripts-esbuild-plugin"
// 2. Remove proper lines in ci.yml for security reasons
// 3. create dummy commits and push to forked repo
// for entire hash: git log --format="%H" -n 1
// for description of last commit: git log --oneline -n 1
// commit message: "..."
const CI_COMMIT_SHA = 'a72b5c327db3cb54a583a2a17d4df5978a846d91'; 
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

function extractArtifact(artifact, tempFileName) {
  console.log(`writing content to ${tempFileName} and unzipping`);
  fs.writeFileSync(tempFileName, Buffer.from(artifact.data));
  execSync(`unzip -o ${tempFileName}`);
  
  const exists = fs.existsSync(artifact.name);
  console.log(`${artifact.name} was extracted: ${exists}`);
  
  if (!exists) {
    throw new Error(`${artifact.name} was not found after extraction`);
  }
  
  fs.unlinkSync(tempFileName);
  return artifact.name;
}

async function getBuildArtifact() {  // maybe my personal access token
  const octokit = new Octokit({ auth: PUBLIC_ARTIFACTS_TOKEN });
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;

  console.log('waiting for workflow results');

  const run = await waitForWorkflowRun({ octokit, owner, repo });  

  console.log('found finished workflow run', run);

  const tgzName = `splunk-otel-${version}.tgz`
  const workspacePackageName = `workspace-packages`;

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

  console.log('downloaded', splunkOtelArtifact);
  // Extract Splunk Otel package
  const splunkOtelTempFile = 'splunk-otel-artifact-temp.zip';
  console.log(`writing content to ${splunkOtelTempFile} and unzipping`);
  fs.writeFileSync(splunkOtelTempFile, Buffer.from(splunkOtelArtifact.data));
  execSync(`unzip -o ${splunkOtelTempFile}`);

  const splunkOtelExists = fs.existsSync(splunkOtelArtifact.name);
  console.log(`${splunkOtelArtifact.name} was extracted: ${splunkOtelExists}`);
  if (!splunkOtelExists) {
    throw new Error(`${splunkOtelArtifact.name} was not found after extraction`);
  }

  // Extract workspace packages to temporary folder
  const tempPackagesDir = 'temp-packages';
  fs.mkdirSync(tempPackagesDir, { recursive: true });

  const workspaceTempFile = 'workspace-package-artifact-temp.zip';
  console.log(`writing workspace content to ${workspaceTempFile} and unzipping to ${tempPackagesDir}`);
  fs.writeFileSync(workspaceTempFile, Buffer.from(workspaceArtifact.data));
  execSync(`unzip -o ${workspaceTempFile} -d ${tempPackagesDir}`);

  // Check that workspace packages were extracted
  const workspaceFiles = fs.readdirSync(tempPackagesDir);
  if (workspaceFiles.length === 0) {
    throw new Error('No .tgz files found in workspace packages');
  }

  // Move extracted workspace packages to root directory
  workspaceFiles.forEach(file => {
    const srcPath = path.join(tempPackagesDir, file);
    const destPath = file;
    fs.renameSync(srcPath, destPath);
  });

  // Remove temporary files and folders
  fs.rmSync(tempPackagesDir, { recursive: true, force: true });
  fs.unlinkSync(splunkOtelTempFile);
  fs.unlinkSync(workspaceTempFile);

  return [splunkOtelArtifact.name, ...workspaceFiles];
}

async function prepareReleaseArtifact() {
  const artifactNames = await getBuildArtifact();

  fs.mkdirSync('dist', { recursive: true });
  artifactNames.forEach(artifactName => {
    fs.renameSync(artifactName, path.join('dist', artifactName));
  });

  console.log('successfully prepared artifacts');
}

prepareReleaseArtifact().catch(e => {
  console.error(e);
  process.exit(1);
});
