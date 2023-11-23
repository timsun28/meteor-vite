import path from 'node:path'
import { performance } from 'node:perf_hooks'
import fs from 'fs-extra'
import { execaSync } from 'execa'
import pc from 'picocolors'
import { createWorkerFork, cwd, getProjectPackageJson, meteorPackagePath } from './workers';
import os from 'node:os';

const pkg = getProjectPackageJson();

const meteorMainModule = pkg.meteor?.mainModule?.client
// Meteor packages to omit or replace the temporary build.

// Useful for other build-time packages that may conflict with Meteor-Vite's temporary build.
const replaceMeteorPackages = [
  { startsWith: 'standard-minifier', replaceWith: '' },
  { startsWith: 'refapp:meteor-typescript', replaceWith: 'typescript' },
  ...pkg?.meteorVite?.replacePackages || []
]
if (!meteorMainModule) {
  throw new Error('No meteor main module found, please add meteor.mainModule.client to your package.json')
}
const tempDir = getTempDir();

const viteStubTempDir = path.join(cwd, 'node_modules', 'meteor-vite', 'temp')
const viteStubFile = path.join(viteStubTempDir, 'stubs.js')
const tempMeteorProject = path.resolve(tempDir, 'meteor')
const tempMeteorOutDir = path.join(tempDir, 'bundle', 'meteor')
const viteOutDir = path.join(tempDir, 'bundle', 'vite');

// Not in a project (publishing the package)
if (process.env.VITE_METEOR_DISABLED) return

// Empty stubs from any previous builds
{
  fs.writeFileSync(viteStubFile, `// Stub file for Meteor-Vite\n`, 'utf8');
}


if (process.env.NODE_ENV !== 'production') return


// Temporary Meteor build

const filesToCopy = [
  path.join('.meteor', '.finished-upgraders'),
  path.join('.meteor', '.id'),
  path.join('.meteor', 'packages'),
  path.join('.meteor', 'platforms'),
  path.join('.meteor', 'release'),
  path.join('.meteor', 'versions'),
  'package.json',
  meteorMainModule,
]

const optionalFiles = [
    'tsconfig.json'
]

try {
  // Temporary Meteor build

  console.log(pc.blue('⚡️ Building packages to make them available to export analyzer...'))
  let startTime = performance.now()

  // Check for project files that may be important if available
  for (const file of optionalFiles) {
    if (fs.existsSync(path.join(cwd, file))) {
      filesToCopy.push(file);
    }
  }

  // Copy files from `.meteor`
  for (const file of filesToCopy) {
    const from = path.join(cwd, file)
    const to = path.join(tempMeteorProject, file)
    fs.ensureDirSync(path.dirname(to))
    fs.copyFileSync(from, to)
  }

  // Symblink to `packages` folder
  if (fs.existsSync(path.join(cwd, 'packages')) && !fs.existsSync(path.join(tempMeteorProject, 'packages'))) {
    fs.symlinkSync(path.join(cwd, 'packages'), path.join(tempMeteorProject, 'packages'))
  }
  // Remove/replace conflicting Atmosphere packages
  {
    const file = path.join(tempMeteorProject, '.meteor', 'packages')
    let content = fs.readFileSync(file, 'utf8')
    for (const pack of replaceMeteorPackages) {
      const lines = content.split('\n')
      content = lines.map(line => {
        if (!line.startsWith(pack.startsWith)) {
          return line;
        }
        return pack.replaceWith || '';
      }).join('\n')
    }
    fs.writeFileSync(file, content)
  }
  // Remove server entry
  {
    const file = path.join(tempMeteorProject, 'package.json')
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    data.meteor = {
      mainModule: {
        client: data.meteor.mainModule.client,
      },
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
  }
  // Only keep meteor package imports to enable lazy packages
  {
    const file = path.join(tempMeteorProject, meteorMainModule)
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const imports = lines.filter(line => line.startsWith('import') && line.includes('meteor/'))
    fs.writeFileSync(file, imports.join('\n'))
  }
  execaSync('meteor', [
    'build',
    tempMeteorOutDir,
    '--directory',
    // Ensure the temporary build doesn't abort for projects with mobile builds
    // Since this is only a temporary build, it shouldn't impact the final production build for the developer.
    '--server=http://localhost:3000',
  ], {
    cwd: tempMeteorProject,
    // stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      FORCE_COLOR: '3',
      VITE_METEOR_DISABLED: 'true',
    },
  })
  let endTime = performance.now()

  console.log(pc.green(`⚡️ Packages built (${Math.round((endTime - startTime) * 100) / 100}ms)`))

  // Vite

  console.log(pc.blue('⚡️ Building with Vite...'))
  startTime = performance.now()

  fs.ensureDirSync(path.dirname(viteOutDir))

  // Build with vite
  const { payload } = Promise.await(new Promise((resolve, reject) => {
    const worker = createWorkerFork({
      buildResult: (result) => resolve(result) ,
    });

    worker.call({
      method: 'buildForProduction',
      params: [{
        viteOutDir,
        packageJson: pkg,
        meteor: {
          packagePath: path.join(tempMeteorOutDir, 'bundle', 'programs', 'web.browser', 'packages'),
          isopackPath: path.join(tempMeteorProject, '.meteor', 'local', 'isopacks'),
          globalMeteorPackagesDir: meteorPackagePath,
        },
      }],
    })
  }))

  if (payload.success) {
    endTime = performance.now()
    console.log(pc.green(`⚡️ Build successful (${Math.round((endTime - startTime) * 100) / 100}ms)`))

    const entryAsset = payload.output.find(o => o.fileName === 'meteor-entry.js' && o.type === 'chunk')
    if (!entryAsset) {
      throw new Error('No meteor-entry chunk found')
    }

    // Add assets to Meteor

    // Copy the assets to the Meteor auto-imported sources
    const viteOutSrcDir = path.join(cwd, 'client', 'vite')
    fs.ensureDirSync(viteOutSrcDir)
    fs.emptyDirSync(viteOutSrcDir)
    const files = payload.output.map(o => o.fileName)
    for (const file of files) {
      const from = path.join(viteOutDir, file)
      const to = path.join(viteOutSrcDir, file)
      fs.ensureDirSync(path.dirname(to))

      if (path.extname(from) === '.js') {
        // Transpile to Meteor target (Dynamic import support)
        // @TODO don't use Babel
        const source = fs.readFileSync(from, 'utf8')
        const babelOptions = Babel.getDefaultOptions()
        babelOptions.babelrc = true
        babelOptions.sourceMaps = true
        babelOptions.filename = babelOptions.sourceFileName = from
        const transpiled = Babel.compile(source, babelOptions, {
          cacheDirectory: path.join(cwd, 'node_modules', '.babel-cache'),
        })
        fs.writeFileSync(to, transpiled.code, 'utf8')
      } else {
        fs.copyFileSync(from, to)
      }
    }

    // Patch meteor entry if needed
    const meteorEntry = path.join(cwd, meteorMainModule)
    const originalEntryContent = fs.readFileSync(meteorEntry, 'utf8');
    if (!originalEntryContent.includes(`import 'meteor-vite'`)) {
        let note = '// This import is automatically generated by Meteor-Vite while building for production. ';
        note += `Feel free to remove it.\n`
        fs.writeFileSync(meteorEntry, `import 'meteor-vite' ${note}\n${originalEntryContent}`, 'utf8')
    }

    // Patch meteor-vite's temporary stub file with imports for the new production bundle.
    const viteBundleImport = `import ${JSON.stringify(`./${path.relative(path.dirname(viteStubFile), path.join(viteOutSrcDir, entryAsset.fileName))}`)}`
    fs.writeFileSync(viteStubFile, viteBundleImport, 'utf8')

    class Compiler {
      processFilesForTarget (files) {
        files.forEach(file => {
          switch (path.extname(file.getBasename())) {
            case '.js':
              file.addJavaScript({
                path: file.getPathInPackage(),
                data: file.getContentsAsString(),
              })
              break
            case '.css':
              file.addStylesheet({
                path: file.getPathInPackage(),
                data: file.getContentsAsString(),
              })
              break
            default:
              file.addAsset({
                path: file.getPathInPackage(),
                data: file.getContentsAsBuffer(),
              })
          }
        })
      }

      afterLink () {
        fs.removeSync(viteOutSrcDir)
      }
    }

    Plugin.registerCompiler({
      extensions: [],
      filenames: files.map(file => path.basename(file)),
    }, () => new Compiler())
  } else {
    throw new Error('Vite build failed')
  }

} catch (e) {
  throw e
}

function getTempDir() {
  try {
    const tempDir = path.resolve(pkg?.meteorVite?.tempDir || os.tmpdir(), 'meteor-vite', pkg.name);
    fs.mkdirSync(tempDir, { recursive: true });
    return tempDir;
  } catch (error) {
    console.warn(new Error(`⚡  Unable to set up temp directory for meteor-vite bundles. Will use node_modules instead`, { cause: error }));
    return path.resolve(cwd, 'node_modules', '.vite-meteor-temp');
  }
}
