/********************************************************************************
 * Copyright (C) 2017 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { injectable, inject, postConstruct } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { CompositeTreeNode, TreeModelImpl, TreeNode, ConfirmDialog } from '@theia/core/lib/browser';
import { FileSystem } from '../../common';
import { FileSystemWatcher, FileChangeType, FileChange, FileMoveEvent } from '../filesystem-watcher';
import { FileStatNode, DirNode, FileNode } from './file-tree';
import { LocationService } from '../location';
import { LabelProvider } from '@theia/core/lib/browser/label-provider';
import { FileService } from '../file-service';
import { WorkingCopyFileService } from '../working-copy-file-service';
import { FileOperationError, FileOperationResult } from '../../common/files';
import { MessageService } from '@theia/core/lib/common/message-service';

@injectable()
export class FileTreeModel extends TreeModelImpl implements LocationService {

    @inject(LabelProvider) protected readonly labelProvider: LabelProvider;

    /**
     * @deprecated since 1.4.0 - in order to suppot VS Code FS API (https://github.com/eclipse-theia/theia/pull/7908),
     * use instead `this.fileService` to read and `this.workingCopyFileService` to write
     */
    @inject(FileSystem)
    protected readonly fileSystem: FileSystem;

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WorkingCopyFileService)
    protected readonly workingCopyFileService: WorkingCopyFileService;

    @inject(FileSystemWatcher)
    protected readonly watcher: FileSystemWatcher;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @postConstruct()
    protected init(): void {
        super.init();
        this.toDispose.push(this.watcher.onFilesChanged(changes => this.onFilesChanged(changes)));
        this.toDispose.push(this.watcher.onDidMove(move => this.onDidMove(move)));
    }

    get location(): URI | undefined {
        const root = this.root;
        if (FileStatNode.is(root)) {
            return root.uri;
        }
        return undefined;
    }

    set location(uri: URI | undefined) {
        if (uri) {
            this.fileService.resolve(uri, { resolveSingleChildDescendants: true, resolveMetadata: false }).then(fileStat => {
                if (fileStat) {
                    const node = DirNode.createRoot(fileStat);
                    this.navigateTo(node);
                }
            });
        } else {
            this.navigateTo(undefined);
        }
    }

    async drives(): Promise<URI[]> {
        try {
            const drives = await this.fileSystem.getDrives();
            return drives.map(uri => new URI(uri));
        } catch (e) {
            this.logger.error('Error when loading drives.', e);
            return [];
        }
    }

    get selectedFileStatNodes(): Readonly<FileStatNode>[] {
        return this.selectedNodes.filter(FileStatNode.is);
    }

    *getNodesByUri(uri: URI): IterableIterator<TreeNode> {
        const node = this.getNode(uri.toString());
        if (node) {
            yield node;
        }
    }

    /**
     * to workaround https://github.com/Axosoft/nsfw/issues/42
     */
    protected onDidMove(move: FileMoveEvent): void {
        if (FileMoveEvent.isRename(move)) {
            return;
        }
        this.refreshAffectedNodes([
            move.sourceUri,
            move.targetUri
        ]);
    }

    protected onFilesChanged(changes: FileChange[]): void {
        if (!this.refreshAffectedNodes(this.getAffectedUris(changes)) && this.isRootAffected(changes)) {
            this.refresh();
        }
    }

    protected isRootAffected(changes: FileChange[]): boolean {
        const root = this.root;
        if (FileStatNode.is(root)) {
            return changes.some(change =>
                change.type < FileChangeType.DELETED && change.uri.toString() === root.uri.toString()
            );
        }
        return false;
    }

    protected getAffectedUris(changes: FileChange[]): URI[] {
        return changes.filter(change => !this.isFileContentChanged(change)).map(change => change.uri);
    }

    protected isFileContentChanged(change: FileChange): boolean {
        return change.type === FileChangeType.UPDATED && FileNode.is(this.getNodesByUri(change.uri).next().value);
    }

    protected refreshAffectedNodes(uris: URI[]): boolean {
        const nodes = this.getAffectedNodes(uris);
        for (const node of nodes.values()) {
            this.refresh(node);
        }
        return nodes.size !== 0;
    }

    protected getAffectedNodes(uris: URI[]): Map<string, CompositeTreeNode> {
        const nodes = new Map<string, CompositeTreeNode>();
        for (const uri of uris) {
            for (const node of this.getNodesByUri(uri.parent)) {
                if (DirNode.is(node) && node.expanded) {
                    nodes.set(node.id, node);
                }
            }
        }
        return nodes;
    }

    copy(uri: URI): boolean {
        const node = this.selectedFileStatNodes[0];
        if (!node) {
            return false;
        }
        const targetUri = node.uri.resolve(uri.path.base);
        this.workingCopyFileService.copy(uri, targetUri);
        return true;
    }

    /**
     * Move the given source file or directory to the given target directory.
     */
    async move(source: TreeNode, target: TreeNode): Promise<void> {
        if (DirNode.is(target) && FileStatNode.is(source)) {
            try {
                await this.workingCopyFileService.move(source.uri, target.uri);
            } catch (e) {
                if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_MOVE_CONFLICT) {
                    const fileName = this.labelProvider.getName(source);
                    if (await this.shouldReplace(fileName)) {
                        try {
                            await this.workingCopyFileService.move(source.uri, target.uri, true /* overwrite */);
                        } catch (e2) {
                            this.messageService.error(e2.message);
                        }
                    }
                } else {
                    this.messageService.error(e.message);
                }
            }
        }
    }

    protected async shouldReplace(fileName: string): Promise<boolean> {
        const dialog = new ConfirmDialog({
            title: 'Replace file',
            msg: `File '${fileName}' already exists in the destination folder. Do you want to replace it?`,
            ok: 'Yes',
            cancel: 'No'
        });
        return !!await dialog.open();
    }

}
