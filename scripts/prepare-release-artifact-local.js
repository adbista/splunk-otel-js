const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const { Octokit } = require('octokit');
const util = require('util'); 

const { version } = require('../package.json');

const WORKFLOW_TIMEOUT_MS = 15 * 60 * 1000;

const PUBLIC_ARTIFACTS_TOKEN = process.env.PUBLIC_ARTIFACTS_TOKEN ?? 'NOT_SET';
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
const CI_COMMIT_SHA = 'c2fdc845ccc9366d2bc49ea9026053c23252d624'; 
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchWorkflowRun(context) {
  const { data: workflows } = await context.octokit.rest.actions.listWorkflowRunsForRepo({
    owner: context.owner,
    repo: context.repo,
  });
  console.log('fetchWorkflowRun:response', workflows);

  const runs = workflows.workflow_runs;
// add commit sha 
  const commitSha = CI_COMMIT_SHA;
  const run = runs.find(wf => wf.head_sha === commitSha && wf.name.toLowerCase() === 'continuous integration');

  if (run === undefined) {
    throw new Error(`Workflow not found for commit ${commitSha}`);
  }
  console.log('fetchWorkflowRun:match', run);

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

async function getBuildArtifact() {  // maybe my personal access token
  const octokit = new Octokit({ auth: PUBLIC_ARTIFACTS_TOKEN });
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;

  console.log('waiting for workflow results');

  const run = await waitForWorkflowRun({ octokit, owner, repo });  

  console.log('found finished workflow run', run);

  const tgzName = `splunk-otel-${version}.tgz`
  const workspacePackageName = `workspace-packages`;

  const { data: splunkOtelArtifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: run.id,
    name: tgzName,
  });

  const { data: workspacePackageArtifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: run.id,
    name: workspacePackageName,
  });

  const splunkOtelPackageArtifact = splunkOtelArtifacts.artifacts.find(artifact => artifact.name === tgzName);
  const workspacePackageArtifact = workspacePackageArtifacts.artifacts.find(artifact => artifact.name === workspacePackageName);

  if (splunkOtelPackageArtifact === undefined) {
    throw new Error(`unable to find artifact named ${tgzName}`);
  }
  console.log('splunkOtelPackageArtifact:', splunkOtelPackageArtifact);
  if (workspacePackageArtifact === undefined) {
    throw new Error(`unable to find artifact named ${workspacePackageName}`);
  }
  console.log('workspacePackageArtifact:', workspacePackageArtifact);

  const SplunkOtelDlArtifact = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: splunkOtelPackageArtifact.id,
    archive_format: 'zip',
  });

  const WorkspacePackageDlArtifact = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: workspacePackageArtifact.id,
    archive_format: 'zip',
  });

  console.log('downloaded artifacts successfully');
  
  // Extract splunk-otel package
  const splunkOtelTempFile = 'splunk-otel-artifact-temp.zip';
  console.log(`writing content to ${splunkOtelTempFile} and unzipping`);
  fs.writeFileSync(splunkOtelTempFile, Buffer.from(SplunkOtelDlArtifact.data));
  execSync(`unzip -o ${splunkOtelTempFile}`);

  // Extract workspace packages to temp folder
  const tempPackagesDir = 'temp-packages';
  fs.mkdirSync(tempPackagesDir, { recursive: true });
  
  const workspaceTempFile = 'workspace-package-artifact-temp.zip';
  console.log(`writing workspace content to ${workspaceTempFile} and unzipping to ${tempPackagesDir}`);
  fs.writeFileSync(workspaceTempFile, Buffer.from(WorkspacePackageDlArtifact.data));
  execSync(`unzip -o ${workspaceTempFile} -d ${tempPackagesDir}`);

  console.log('Files after extraction:');
  console.log('Root directory:', fs.readdirSync('.'));
  console.log('Temp packages directory:', fs.readdirSync(tempPackagesDir));

  // Check splunk-otel package
  const splunkOtelExists = fs.existsSync(splunkOtelPackageArtifact.name);
  console.log(`${splunkOtelPackageArtifact.name} was extracted: ${splunkOtelExists}`);

  // Find workspace .tgz files in temp directory
  const workspaceFiles = fs.readdirSync(tempPackagesDir);
  const workspaceTgzFiles = workspaceFiles.filter(file => file.endsWith('.tgz'));
  console.log(`Found workspace .tgz files: ${workspaceTgzFiles}`);

  if (!splunkOtelExists) {
    throw new Error(`${splunkOtelPackageArtifact.name} was not found after extraction`);
  }

  if (workspaceTgzFiles.length === 0) {
    throw new Error('No .tgz files found in workspace packages');
  }

  // Move workspace .tgz files to root directory
  workspaceTgzFiles.forEach(file => {
    const srcPath = path.join(tempPackagesDir, file);
    const destPath = file;
    fs.renameSync(srcPath, destPath);
    console.log(`Moved ${srcPath} to ${destPath}`);
  });

  // Clean up temp directory
  fs.rmSync(tempPackagesDir, { recursive: true, force: true });
  fs.unlinkSync(splunkOtelTempFile);
  fs.unlinkSync(workspaceTempFile);

  return [splunkOtelPackageArtifact.name, ...workspaceTgzFiles];
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
