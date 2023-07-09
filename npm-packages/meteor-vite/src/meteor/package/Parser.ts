import { parse } from '@babel/parser';
import {
    CallExpression, ExpressionStatement,
    FunctionExpression, Identifier, is, MemberExpression,
    Node, NumericLiteral,
    ObjectExpression, ObjectMethod,
    ObjectProperty, shallowEqual, StringLiteral,
    traverse,
} from '@babel/types';
import FS from 'fs/promises';
import MeteorPackage from './MeteorPackage';

interface ParseOptions {
    /**
     * Absolute file path to the package's JavaScript file.
     * This file needs to have been built by Meteor.
     * The package source code is not handled by the parser.
     */
    filePath: string;
    
    /**
     * Optionally use file content from memory instead of pulling the file content during parser setup.
     * Used primarily to save a few milliseconds for the Vite plugin requests.
     *
     * We still want the filePath property to maintain good traceability for error messages.
     */
    fileContent?: Promise<string> | string;
}

export async function parseMeteorPackage({ fileContent, filePath }: ParseOptions) {
    const startTime = Date.now();
    
    const result: ParsedPackage = await parseSource(
        await (fileContent || FS.readFile(filePath, 'utf-8'))
    ).catch((error: Error) => {
        if (error instanceof ModuleExportsError) {
            console.error(error);
            throw new ParserError('Failed to parse source code. See previous error.')
        }
        throw error;
    })
    
    if (!result.name) {
        throw new ParserError(`Could not extract name from package in: ${filePath}`);
    }
    
    const moduleExports = Object.keys(result.modules);
    const packageExports = Object.keys(result.packageScopeExports);
    
    if (!moduleExports.length && !packageExports.length) {
        console.warn(
            'Unable to retrieve any metadata from the provided source code!',
            { result }
        );
        throw new ParserError(`No modules or package-scope exports could be extracted from package: ${result.name}`);
    }
    
    return new MeteorPackage(result, {
        timeSpent: `${Date.now() - startTime}ms`
    })
}


function parseSource(code: string) {
    return new Promise<ParsedPackage>((resolve, reject) => {
        const source = parse(code);
        const result: ParsedPackage = {
            name: '',
            modules: {},
            packageScopeExports: {},
            mainModulePath: '',
        }
        
        traverse(source, {
            enter(node) {
                const packageScope = parsePackageScope(node);
                const meteorInstall = parseMeteorInstall(node);
                result.mainModulePath = readMainModulePath(node) || result.mainModulePath;
                
                if (meteorInstall) {
                    Object.assign(result, meteorInstall)
                }
                
                if (packageScope) {
                    result.name = result.name || packageScope.name;
                    result.packageScopeExports[packageScope.name] = packageScope.exports;
                }
            }
        });
        
        resolve(result);
    })
}

function readMainModulePath(node: Node) {
    if (node.type !== 'VariableDeclarator') return;
    if (!is('Identifier', node.id, { name: 'exports' })) return;
    if (node.init?.type !== 'CallExpression') return;
    if (!is('Identifier', node.init.callee, { name: 'require' })) return;
    if (node.init.arguments[0]?.type !== 'StringLiteral') return;
    
    // node_modules/meteor/<author>:<packageName>/<mainModule>
    return node.init.arguments[0].value;
}


function parsePackageScope(node: Node) {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type !== 'MemberExpression') return;
    const { object, property } = node.callee;
    if (object.type !== 'Identifier') return;
    if (object.name !== 'Package') return;
    if (property.type !== 'Identifier') return;
    if (property.name !== '_define') return;
    
    const packageName = node.arguments[0];
    const moduleExports = node.arguments[1];
    let packageExports = node.arguments[2];
    
    // Deals with the meteor/meteor core packages that don't use the module system.
    if (!packageExports && node.arguments[1]?.type === 'ObjectExpression') {
        packageExports = moduleExports;
    }
    
    if (!packageExports) return;
    if (packageExports.type !== 'ObjectExpression') {
        throw new ModuleExportsError('Unexpected type received for package-scope exports argument!', packageExports);
    }
    if (packageName.type !== 'StringLiteral') {
        throw new ModuleExportsError('Unexpected type received for package name!', packageName);
    }
    
    const packageExport = {
        name: packageName.value,
        exports: [] as string[],
    };
    
    packageExports.properties.forEach((property) => {
        if (property.type === 'SpreadElement') {
            throw new ModuleExportsError('Unexpected property type received for package-scope exports!', property)
        }
        
        packageExport.exports.push(propParser.getKey(property));
    })
    
    return packageExport;
}

function parseMeteorInstall(node: Node): Pick<ParsedPackage, 'modules' | 'name'> | undefined {
    if (node.type !== 'CallExpression') return;
    if (!is('Identifier', node.callee, { name: 'meteorInstall' })) return;
    
    const packageConfig = node.arguments[0] as PackageConfig;
    const node_modules = packageConfig.properties[0];
    const meteor = node_modules.value.properties[0];
    const packageName = meteor.value.properties[0];
    const packageModules = packageName.value.properties;
    const traverseModules = (properties: MeteorPackageProperty[], parentPath: string) => {
        properties.forEach((property) => {
            const path = `${parentPath}${property.key.value.toString()}`
            const exportList: ModuleExport[] = [];
            
            if (property.value.type === 'ObjectExpression') {
                return traverseModules(property.value.properties, `${path}/`);
            }
            
            modules[path] = exportList;
            
            property.value.body.body.forEach((node) => {
                const exports = readModuleExports(node);
                if (!exports) {
                    return;
                }
                exportList.push(...exports);
            });
        })
    }
    
    const modules: ModuleList = {};
    traverseModules(packageModules, '');

    return {
        name: packageName.key.value,
        modules,
    };
}

function readModuleExports(node: Node) {
    if (node.type !== 'ExpressionStatement') return;
    if (node.expression.type === 'UnaryExpression') {
        return handleMainModule(node);
    }
    if (node.expression.type !== 'CallExpression') return;
    const { callee, arguments: args } = node.expression;
    if (callee.type !== 'MemberExpression') return;
    if (callee.object.type !== 'Identifier') return;

    // Meteor's module declaration object. `module.`
    if (!callee.object.name.match(/^module\d*$/)) return;
    if (callee.property.type !== 'Identifier') return;
    const methodName = callee.property.name as 'export' | 'link' | 'exportDefault';
    
    
    if (methodName === 'exportDefault') {
        if (args[0].type !== 'Identifier') {
            throw new ModuleExportsError('Unexpected default export value!', args[0]);
        }
        
        // todo: test for default exports with `export default { foo: 'bar' }`
        return [{ type: 'export-default', name: args[0].name, } satisfies ModuleExport];
    }

    // Meteor's module declaration method. `module.export(...)`
    if (methodName === 'export') {
        if (args[0].type !== 'ObjectExpression') throw new ModuleExportsError('Unexpected export type!', exports)
        return formatExports({
            expression: args[0]
        });
    }
    
    // Meteor's module declaration method. `module.link(...)`
    if (methodName !== 'link') return;
    if (args[0].type !== 'StringLiteral') throw new ModuleExportsError('Expected string as the first argument in module.link()!', args[0]);
    if (args[1].type !== 'ObjectExpression') throw new ModuleExportsError('Expected ObjectExpression as the second argument in module.link()!', args[0]);
    if (args[2].type !== 'NumericLiteral') throw new ModuleExportsError('Expected NumericLiteral as the last argument in module.link()!', args[0]);

    return formatExports({
        packageName: args[0],
        expression: args[1],
        id: args[2],
    })
}

function handleMainModule({ expression }: ExpressionStatement) {
    if (expression.type !== 'UnaryExpression') return;
    if (expression.operator !== '!') return;
    if (expression.argument.type !== 'CallExpression') return;
    const callee = expression.argument.callee
    if (callee.type !== 'MemberExpression') return;
    if (callee.object.type !== 'FunctionExpression') return;
    
    const mainModule = callee.object.body;
    const moduleExports: ReturnType<typeof formatExports> = [];
    
    mainModule.body.forEach((node) => {
        const exports = readModuleExports(node);
        if (!exports) return;
        moduleExports.push(...exports)
    });
    
    return moduleExports;
}

const propParser = {
    getKey(property: ObjectMethod | ObjectProperty) {
        if (property.key.type === 'Identifier') {
            return property.key.name;
        }
        if (property.key.type === 'StringLiteral') {
            return property.key.value;
        }
        
        throw new ModuleExportsError('Unsupported property key type!', property);
    },
}

function formatExports({ expression, packageName, id }: {
    expression: ObjectExpression,
    packageName?: StringLiteral,
    id?: NumericLiteral,
}) {
    return expression.properties.map((property) => {
        if (property.type === "SpreadElement") throw new ModuleExportsError('Unexpected property type!', property);
        const result: ModuleExport = {
            name: propParser.getKey(property),
            type: 'export',
            ...id && { id: id.value }
        }
        
        if (packageName) {
            result.type = 're-export';
            result.from = packageName.value;
        }
        
        if (result.type === 're-export' && property.type === 'ObjectMethod') {
            result.type = 'global-binding';
        }
        
        if (result.type === 're-export' && property.type === 'ObjectProperty') {
            const content = property.value;
            if (content.type !== 'StringLiteral') {
                throw new ModuleExportsError('Received unsupported result type in re-export!', property);
            }
            
            if (content.value !== result.name) {
                result.as = content.value;
            }
        }
        
        return result;
    })
    
}

class ParserError extends Error {}
class ModuleExportsError extends ParserError {
    constructor(
        public readonly message: string,
        public readonly node: Node
    ) {
        super(message);
    }
}

/**
 * Meteor package-level exports.
 * @link https://docs.meteor.com/api/packagejs.html#PackageAPI-export
 */
export type PackageScopeExports = Record<string, string[]>;
export type ModuleList = { [key in string]: ModuleExport[] };
export type ModuleExport = {
    /**
     * "Name" of the object to be exported.
     * @example ts
     * export const <name> = '...'
     */
    name?: string,
    type: 'export' // Named export (export const fooBar = '...')
          | 're-export' // Exporting properties from another module. (export { fooBar } from './somewhere'  )
          | 'global-binding' // Meteor globals. (`Meteor`, `DDP`, etc) These should likely just be excluded from the vite stubs.
          | 'export-default' // Default module export (export default fooBar);
    
    /**
     * Internal Meteor ID for a linked Meteor module.
     * This isn't really all that useful apart from testing.
     */
    id?: number;
    
    /**
     * The module we're re-exporting from. This only applies to re-exports.
     * @example ts
     * export { foo } from '<from>'
     */
    from?: string;
    
    /**
     * The value of the "as" keyword when exporting a module.
     * @example ts
     * export { foo as bar }
     */
    as?: string;
};

export interface ParsedPackage {
    /**
     * Meteor Atmosphere package name.
     * E.g. ostrio:cookies, accounts-base, ddp
     */
    name: string;
    
    /**
     * List of ES modules included in this package.
     */
    modules: ModuleList;
    
    /**
     * Path to the package's mainModule as defined with `api.mainModule(...)`
     * @link https://docs.meteor.com/api/packagejs.html
     */
    mainModulePath?: string;
    
    /**
     * Meteor package-level exports.
     * @link https://docs.meteor.com/api/packagejs.html#PackageAPI-export
     */
    packageScopeExports: PackageScopeExports;
}


type KnownObjectProperty<TValue extends Pick<ObjectProperty, 'key' | 'value'>> = Omit<ObjectProperty, 'key' | 'value'> & TValue;
type KnownObjectExpression<TValue extends Pick<ObjectExpression, 'properties'>> = Omit<ObjectExpression, 'properties'> & TValue;

type MeteorPackageProperty = KnownObjectProperty<{
    key: StringLiteral, // File name
    value: FunctionExpression | MeteorNestedPackageProperty, // Module function
}>
type MeteorNestedPackageProperty = KnownObjectExpression<{
    properties: MeteorPackageProperty[]
}>

type PackageConfig = KnownObjectExpression<{
    properties: [KnownObjectProperty<{
        key: StringLiteral & { value: 'node_modules' }
        value: KnownObjectExpression<{
            properties: [KnownObjectProperty<{
                key: StringLiteral & { value: 'meteor' },
                value: KnownObjectExpression<{
                    properties: [KnownObjectProperty<{
                        key: StringLiteral, // Package name
                        value: KnownObjectExpression<{
                            properties: MeteorPackageProperty[]
                        }>
                    }>]
                }>
            }>]
        }>
    }>]
}>