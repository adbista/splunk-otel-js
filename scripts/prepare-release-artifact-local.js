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
const CI_COMMIT_SHA = '...'; 
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function dbg(label, data) {
  console.log(`\n\u001b[36m[${label}]\u001b[0m`);
  if (data !== undefined) {
    console.log(util.inspect(data, { depth: null, colors: true }));
  }
}

async function fetchWorkflowRun(context) {
  const { data: workflows } = await context.octokit.rest.actions.listWorkflowRunsForRepo({
    owner: context.owner,
    repo: context.repo,
  });
  dbg('fetchWorkflowRun:response', workflows);

  const runs = workflows.workflow_runs;
// add commit sha 
  const commitSha = CI_COMMIT_SHA;
  const run = runs.find(wf => wf.head_sha === commitSha && wf.name.toLowerCase() === 'continuous integration');

  if (run === undefined) {
    throw new Error(`Workflow not found for commit ${commitSha}`);
  }
  dbg('fetchWorkflowRun:match', run);

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
  dbg('getBuildArtifact:workflowRun', run);

  console.log('found finished workflow run', run);

  const tgzName = `splunk-otel-${version}.tgz`
  const { data: artifacts } = await octokit.rest.actions.listWorkflowRunArtifacts({
    owner,
    repo,
    run_id: run.id,
    name: tgzName,
  });

  console.log('found artifacts for workflow', artifacts);

  dbg('getBuildArtifact:artifactsList', artifacts);

  const packageArtifact = artifacts.artifacts.find(artifact => artifact.name === tgzName);

  if (packageArtifact === undefined) {
    throw new Error(`unable to find artifact named ${tgzName}`);
  }

  dbg('getBuildArtifact:chosenArtifact', packageArtifact);

  const dlArtifact = await octokit.rest.actions.downloadArtifact({
    owner,
    repo,
    artifact_id: packageArtifact.id,
    archive_format: 'zip',
  });

  console.log('downloaded', dlArtifact);
  dbg('getBuildArtifact:downloadResponse', dlArtifact);

  const tempFile = 'artifact-temp.zip';

  console.log(`writing content to ${tempFile} and unzipping`);

  fs.writeFileSync(tempFile, Buffer.from(dlArtifact.data));
  dbg('getBuildArtifact:unzip', { cmd: `unzip -o ${tempFile}` });
  execSync(`unzip -o ${tempFile}`);

  const exists = fs.existsSync(packageArtifact.name);
  console.log(`${packageArtifact.name} was extracted: ${exists}`);

  if (!exists) {
    throw new Error(`${packageArtifact.name} was not found after extraction`);
  }

  return packageArtifact.name;
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
