"use strict";

import * as vscode from "vscode";
import Generator from "./Generator";
import SubdirectoryGenerator from "./SubdirectoryGenerator";

export function activate(context: vscode.ExtensionContext) {
    // Register the main Generate .gitignore File command
    let disposable = vscode.commands.registerCommand(
        "extension.gitignoreGenerate",
        () => {
            try {
                const generator = new Generator();

                generator.init();
            } catch (e) {
                console.log(e.message);
            }
        }
    );

    context.subscriptions.push(disposable);

    // Register the Generate .gitignore in Subdirectory command
    let subdirectoryDisposable = vscode.commands.registerCommand(
        "extension.gitignoreGenerateInSubdirectory",
        () => {
            try {
                const generator = new SubdirectoryGenerator();

                generator.init();
            } catch (e) {
                console.log(e.message);
            }
        }
    );

    context.subscriptions.push(subdirectoryDisposable);
}

export function deactivate() { }
