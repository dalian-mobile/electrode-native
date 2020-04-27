import { PackagePath } from './PackagePath';
import * as mustacheUtils from './mustacheUtils';
import Mustache from 'mustache';
import shell from './shell';
import { manifest, PluginConfig } from './Manifest';
import handleCopyDirective from './handleCopyDirective';
import log from './log';
import { isDependencyJsApiImpl, isDependencyPathNativeApiImpl } from './utils';
import path from 'path';
import xcode from 'xcode-ern';
import fs from 'fs-extra';
import _ from 'lodash';
import kax from './kax';
import { readPackageJson } from './packageJsonFileUtils';
import { getNativeDependencyPath } from './nativeDependenciesLookup';
import { gitApply } from './gitApply';
import semver from 'semver';
import readDir = require('fs-readdir-recursive');

export async function fillProjectHull(
  pathSpec: {
    rootDir: string;
    projectHullDir: string;
    outputDir: string;
  },
  projectSpec: {
    projectName: string;
    nodeModulesRelativePath?: string;
  },
  plugins: PackagePath[],
  mustacheView?: any,
  composite?: any,
) {
  log.debug(`[=== Starting iOS framework project hull filling ===]`);
  shell.pushd(pathSpec.rootDir);

  try {
    await fs.ensureDir(pathSpec.outputDir);

    shell.cp('-R', pathSpec.projectHullDir, pathSpec.outputDir);

    if (mustacheView) {
      log.debug(`iOS: reading template files to be rendered for plugins`);
      const a = path.join(pathSpec.outputDir, 'ElectrodeContainer');
      const b = path.join(pathSpec.outputDir, 'Config');
      const files = [
        ...readDir(a).map((x) => path.join(a, x)),
        ...readDir(b).map((x) => path.join(b, x)),
      ];
      for (const file of files) {
        if (
          file.endsWith('.h') ||
          file.endsWith('.m') ||
          file.endsWith('.xcconfig')
        ) {
          await mustacheUtils.mustacheRenderToOutputFileUsingTemplateFile(
            file,
            mustacheView,
            file,
          );
        }
      }
    }
    const projectPath = path.join(
      pathSpec.outputDir,
      `${projectSpec.projectName}.xcodeproj`,
      'project.pbxproj',
    );
    const librariesPath = path.join(
      pathSpec.outputDir,
      projectSpec.projectName,
      'Libraries',
    );
    const iosProject = await getIosProject(projectPath);
    const target = iosProject.findTargetKey(projectSpec.projectName);

    const injectPluginsTaskMsg = 'Injecting Native Dependencies';
    const injectPluginsKaxTask = kax.task(injectPluginsTaskMsg);
    const rnVersion = plugins.find((p) => p.name === 'react-native')?.version!;
    const additionalPods = [];
    const destPodfilePath = path.join(pathSpec.outputDir, 'Podfile');

    for (const plugin of plugins) {
      const pluginSourcePath = composite
        ? plugin.basePath
        : await getNativeDependencyPath(
            path.resolve(pathSpec.outputDir, '..', 'node_modules'),
            plugin,
          );
      if (!pluginSourcePath) {
        throw new Error(`path to ${plugin.name} not found.`);
      }

      const localPluginPackage = PackagePath.fromString(pluginSourcePath);

      if (await isDependencyJsApiImpl(localPluginPackage)) {
        log.debug('JS api implementation identified, skipping fill hull.');
        continue;
      }

      let pluginConfig:
        | PluginConfig<'ios'>
        | undefined = await manifest.getPluginConfig(
        plugin,
        'ios',
        projectSpec.projectName,
      );
      if (!pluginConfig) {
        continue;
      }

      log.debug(`Path to ${plugin.name} plugin : ${pluginSourcePath}`);

      if (await isDependencyPathNativeApiImpl(pluginSourcePath)) {
        // For native api implementations, if a 'ern.pluginConfig' object
        // exists in its package.json, replace pluginConfig with this one.
        const pluginPackageJson = await readPackageJson(pluginSourcePath);
        if (pluginPackageJson.ern.pluginConfig) {
          pluginConfig = pluginPackageJson.ern.pluginConfig.ios;
          pluginConfig = JSON.parse(
            Mustache.render(JSON.stringify(pluginConfig), {
              projectName: projectSpec.projectName,
            }),
          );
          pluginConfig!.requiresManualLinking = true;
        }
      }

      injectPluginsKaxTask.text = `${injectPluginsTaskMsg} [${plugin.name}]`;

      const {
        applyPatch,
        copy,
        extraPods,
        pbxproj,
        podfile,
        podspec,
        replaceInFile,
        requiresManualLinking,
        setBuildSettings,
      } = pluginConfig!;

      if (semver.lt(rnVersion, '0.61.0') || requiresManualLinking) {
        if (copy) {
          for (const c of copy) {
            if (switchToOldDirectoryStructure(pluginSourcePath, c.source)) {
              log.debug(
                `Handling copy directive: Falling back to old directory structure for API(Backward compatibility)`,
              );
              c.source = path.normalize('IOS/IOS/Classes/SwaggersAPIs');
            }
          }
          handleCopyDirective(pluginSourcePath, pathSpec.outputDir, copy);
        }

        if (replaceInFile) {
          for (const r of replaceInFile) {
            const pathToFile = path.join(pathSpec.outputDir, r.path);
            const fileContent = await fs.readFile(pathToFile, 'utf8');
            const patchedFileContent = fileContent.replace(
              RegExp(r.string, 'g'),
              r.replaceWith,
            );
            await fs.writeFile(pathToFile, patchedFileContent, {
              encoding: 'utf8',
            });
          }
        }

        if (setBuildSettings) {
          for (const s of setBuildSettings) {
            const pathToPbxProj = path.join(pathSpec.outputDir, s.path);
            // Add any missing section in the target pbxproj
            // This is necessary for proper parsing and modification of
            // the pbxproj with the xcode-ern library
            xcode.pbxProjFileUtils().addMissingSectionsToPbxProj(pathToPbxProj);
            const iosProj = await getIosProject(pathToPbxProj);
            const buildSettings =
              s.buildSettings instanceof Array
                ? s.buildSettings
                : [s.buildSettings];
            for (const buildSettingsEntry of buildSettings) {
              for (const buildType of buildSettingsEntry.configurations) {
                for (const key of Object.keys(buildSettingsEntry.settings)) {
                  iosProj.updateBuildProperty(
                    key,
                    buildSettingsEntry.settings[key],
                    buildType,
                  );
                }
              }
            }
            fs.writeFileSync(pathToPbxProj, iosProj.writeSync());
          }
        }

        if (applyPatch) {
          const { patch, root, inNodeModules } = applyPatch;
          if (!patch) {
            throw new Error('Missing "patch" property in "applyPatch" object');
          }
          if (!root && !inNodeModules) {
            throw new Error(
              'If "inNodeModules" is not set, "root" property must be set in "applyPatch" object',
            );
          }
          const [patchFile, rootDir] = [
            path.join(pluginConfig!.path!, patch),
            inNodeModules
              ? pluginSourcePath
              : path.join(pathSpec.outputDir, root),
          ];
          await gitApply({ patchFile, rootDir });
        }

        if (pbxproj) {
          const {
            addEmbeddedFramework,
            addFile,
            addFramework,
            addFrameworkReference,
            addFrameworkSearchPath,
            addHeader,
            addHeaderSearchPath,
            addProject,
            addSource,
            addStaticLibrary,
          } = pbxproj;

          if (addSource) {
            for (const source of addSource) {
              // Multiple source files
              if (source.from) {
                if (
                  switchToOldDirectoryStructure(pluginSourcePath, source.from)
                ) {
                  log.debug(
                    `Source Copy: Falling back to old directory structure for API(Backward compatibility)`,
                  );
                  source.from = path.normalize(
                    'IOS/IOS/Classes/SwaggersAPIs/*.swift',
                  );
                }
                const relativeSourcePath = path.dirname(source.from);
                const pathToSourceFiles = path.join(
                  pluginSourcePath,
                  relativeSourcePath,
                );
                const fileNames = _.filter(
                  await fs.readdir(pathToSourceFiles),
                  (f) => f.endsWith(path.extname(source.from!)),
                );
                for (const fileName of fileNames) {
                  const fileNamePath = path.join(source.path, fileName);
                  iosProject.addSourceFile(
                    fileNamePath,
                    null,
                    iosProject.findPBXGroupKey({ name: source.group }),
                  );
                }
              } else {
                // Single source file
                iosProject.addSourceFile(
                  source.path,
                  null,
                  iosProject.findPBXGroupKey({ name: source.group }),
                );
              }
            }
          }

          if (addHeader) {
            for (const header of addHeader) {
              // Multiple header files
              if (header.from) {
                if (
                  switchToOldDirectoryStructure(pluginSourcePath, header.from)
                ) {
                  log.debug(
                    `Header Copy: Falling back to old directory structure for API(Backward compatibility)`,
                  );
                  header.from = path.normalize(
                    'IOS/IOS/Classes/SwaggersAPIs/*.swift',
                  );
                }
                const relativeHeaderPath = path.dirname(header.from);
                const pathToHeaderFiles = path.join(
                  pluginSourcePath,
                  relativeHeaderPath,
                );
                const fileNames = _.filter(
                  await fs.readdir(pathToHeaderFiles),
                  (f) => f.endsWith(path.extname(header.from!)),
                );
                for (const fileName of fileNames) {
                  const fileNamePath = path.join(header.path, fileName);
                  iosProject.addHeaderFile(
                    fileNamePath,
                    { public: header.public },
                    iosProject.findPBXGroupKey({ name: header.group }),
                  );
                }
              } else {
                const headerPath = header.path;
                iosProject.addHeaderFile(
                  headerPath,
                  { public: header.public },
                  iosProject.findPBXGroupKey({ name: header.group }),
                );
              }
            }
          }

          if (addFile) {
            for (const file of addFile) {
              iosProject.addFile(
                file.path,
                iosProject.findPBXGroupKey({ name: file.group }),
              );
              // Add target dep in any case for now, will rework later
              iosProject.addTargetDependency(target, [
                `"${path.basename(file.path)}"`,
              ]);
            }
          }

          if (addFramework) {
            for (const framework of addFramework) {
              iosProject.addFramework(framework, {
                customFramework: true,
              });
            }
          }

          if (addProject) {
            for (const project of addProject) {
              const projectAbsolutePath = path.join(
                librariesPath,
                project.path,
                'project.pbxproj',
              );
              const options = {
                addAsTargetDependency: project.addAsTargetDependency,
                frameworks: project.frameworks,
                projectAbsolutePath,
                staticLibs: project.staticLibs,
              };
              iosProject.addProject(
                project.path,
                project.group,
                target,
                options,
              );
            }
          }

          if (addStaticLibrary) {
            for (const lib of addStaticLibrary) {
              iosProject.addStaticLibrary(lib);
            }
          }

          if (addHeaderSearchPath) {
            for (const p of addHeaderSearchPath) {
              iosProject.addToHeaderSearchPaths(p);
            }
          }

          if (addFrameworkReference) {
            for (const frameworkReference of addFrameworkReference) {
              iosProject.addFramework(frameworkReference, {
                customFramework: true,
              });
            }
          }

          if (addEmbeddedFramework) {
            for (const framework of addEmbeddedFramework) {
              iosProject.addFramework(framework, {
                customFramework: true,
                embed: true,
              });
            }
          }

          if (addFrameworkSearchPath) {
            for (const p of addFrameworkSearchPath) {
              iosProject.addToFrameworkSearchPaths(p);
            }
          }
        }
      }

      if (semver.gte(rnVersion, '0.61.0')) {
        if (podfile) {
          if (plugin.name !== 'react-native') {
            throw new Error(
              `ios.podfile directive can only be used for react-native configuration`,
            );
          }
          const sourcePodfilePath = path.join(pluginConfig!.path!, podfile);
          shell.cp(sourcePodfilePath, destPodfilePath);
        }

        if (podspec) {
          const sourcePodspecPath = path.join(pluginConfig!.path!, podspec);
          const destPodspecPath = path.join(pluginSourcePath, podspec);
          shell.cp(sourcePodspecPath, destPodspecPath);
        }

        if (extraPods) {
          additionalPods.push(...extraPods);
        }
      }
    }

    if (semver.gte(rnVersion, '0.61.0')) {
      await mustacheUtils.mustacheRenderToOutputFileUsingTemplateFile(
        destPodfilePath,
        {
          extraPods: additionalPods.reduce(
            (acc, cur) => `${acc}\n  ${cur}`,
            '',
          ),
          nodeModulesRelativePath:
            projectSpec.nodeModulesRelativePath || './node_modules',
          projectName: projectSpec.projectName,
        },
        destPodfilePath,
      );
    }

    injectPluginsKaxTask.succeed(injectPluginsTaskMsg);

    log.debug(`[=== Completed framework generation ===]`);
    return { iosProject, projectPath };
  } finally {
    shell.popd();
  }
}

async function getIosProject(projectPath: string): Promise<any> {
  const project = xcode.project(projectPath);
  return new Promise((resolve, reject) => {
    project.parse((err: any) => {
      if (err) {
        log.error(`failed to get ios project : ${JSON.stringify(err)}`);
        reject(err);
      }

      resolve(project);
    });
  });
}

function switchToOldDirectoryStructure(
  pluginSourcePath: string,
  tail: string,
): boolean {
  // This is to check if the api referenced during container generation is created using the old or new directory structure to help keep the backward compatibility.
  const pathToSwaggersAPIs = path.normalize('IOS/IOS/Classes/SwaggersAPIs');
  if (
    path.dirname(tail) === `IOS` &&
    fs.pathExistsSync(
      path.join(pluginSourcePath, path.dirname(pathToSwaggersAPIs)),
    )
  ) {
    return true;
  }
  return false;
}
