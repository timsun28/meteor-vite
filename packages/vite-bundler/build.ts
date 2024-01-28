import path from 'node:path';
import fs from 'fs-extra';
import { cwd } from './workers';
import Logger from './utility/Logger';
import Compiler, { BUNDLE_FILE_EXTENSION } from './plugin/Compiler';
import { Meteor } from 'meteor/meteor';
import { getBuildConfig, posixPath } from './utility/Helpers';
import { prepareViteBundle, ViteBundleOutput } from './plugin/IntermediaryMeteorProject';

// Not in a project (publishing the package or in temporary Meteor build)
if (process.env.VITE_METEOR_DISABLED) return

const {
  meteorMainModule,
  isSimulatedProduction,
  entryModule,
  entryModuleFilepath,
  viteOutSrcDir,
} = getBuildConfig();

// Empty stubs from any previous builds
{
  fs.ensureDirSync(path.dirname(entryModuleFilepath));
  fs.writeFileSync(entryModuleFilepath, `// Stub file for Meteor-Vite\n`, 'utf8');
}


// In development, clients will connect to the Vite development server directly. So there is no need for Meteor
// to do any work.
if (process.env.NODE_ENV !== 'production') return

Plugin.registerCompiler({
  extensions: [BUNDLE_FILE_EXTENSION],
  filenames: [],
}, () => new Compiler())

try {
  // Meteor v3 build process (Async-await)
  if (Meteor.isFibersDisabled) {
    await processViteBundle();
    return;
  }
  
  // Meteor v2 build process (Fibers)
  Promise.await(processViteBundle());
} catch (error) {
  Logger.error(' Failed to complete build process:\n', error);
  throw error;
}

async function processViteBundle() {
  const { payload, entryAsset } = await prepareViteBundle();
  const viteOutSrcDir = path.join(cwd, 'client', 'vite')
  
  // Transpile and push the Vite bundle into the Meteor project's source directory
  transpileViteBundle({ payload });
  
  const moduleImportPath = JSON.stringify(posixPath(entryModule));
  const meteorViteImport = `import ${moduleImportPath};`
  const meteorViteImportTemplate = `
/**
 * This import is automatically generated by Meteor-Vite while building for production.
 * It should only point to your Vite production bundle, and is perfectly safe to remove or commit.
 *
 * If you're seeing this import including any other files like the Vite plugin itself,
 * Meteor might be trying to import ESM over CommonJS. Please open an issue if this happens.
 * Shouldn't be dangerous, but it might bloat your client bundle.
**/
${meteorViteImport}


`.trimLeft();
  
  // Patch project's meteor entry with import for meteor-vite's entry module.
  // in node_modules/meteor-vite/temp
  const meteorEntry = path.join(cwd, meteorMainModule)
  const originalEntryContent = fs.readFileSync(meteorEntry, 'utf8');
  if (!originalEntryContent.includes(moduleImportPath.replace(/['"`]/g, ''))) {
    fs.writeFileSync(meteorEntry, `${meteorViteImportTemplate}\n${originalEntryContent}`, 'utf8')
  }
  
  // Patch the meteor-vite entry module with an import for the project's Vite production bundle
  // in <project root>/client/vite
  const bundleEntryPath = path.relative(path.dirname(entryModuleFilepath), path.join(viteOutSrcDir, entryAsset.fileName));
  const entryModuleContent = `import ${JSON.stringify(`${posixPath(bundleEntryPath)}`)}`
  fs.writeFileSync(entryModuleFilepath, entryModuleContent, 'utf8')
  
  Compiler.addCleanupHandler(() => {
    if (isSimulatedProduction) return;
    fs.removeSync(viteOutSrcDir);
    fs.writeFileSync(meteorEntry, originalEntryContent, 'utf8');
  });
}

function transpileViteBundle({ payload }: Pick<ViteBundleOutput, 'payload'>) {
  const profile = Logger.startProfiler();
  Logger.info('Transpiling Vite bundle for Meteor...');
  
  fs.ensureDirSync(viteOutSrcDir)
  fs.emptyDirSync(viteOutSrcDir)
  for (const { fileName: file } of payload.output) {
    const from = path.join(payload.outDir, file)
    const to = path.join(viteOutSrcDir, `${file}.${BUNDLE_FILE_EXTENSION}`);
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
  // Add .gitignore file to prevent the transpiled bundle from being committed accidentally.
  fs.writeFileSync(path.join(viteOutSrcDir, '.gitignore'), '/**');
  
  profile.complete('Transpile completed');
}
