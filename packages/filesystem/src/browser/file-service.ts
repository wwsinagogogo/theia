/********************************************************************************
 * Copyright (C) 2020 TypeFox and others.
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
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable max-len */
/* eslint-disable no-shadow */
/* eslint-disable no-null/no-null */
/* eslint-disable @typescript-eslint/tslint/config */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { injectable, inject } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { CancellationToken, CancellationTokenSource } from '@theia/core/lib/common/cancellation';
import { Disposable, DisposableCollection } from '@theia/core/src/common/disposable';
import { Emitter } from '@theia/core/src/common/event';
import { TernarySearchTree } from '@theia/core/lib/common/ternary-search-tree';
import {
    ensureFileSystemProviderError, etag, ETAG_DISABLED,
    FileChangesEvent,
    FileOperation, FileOperationError,
    FileOperationEvent, FileOperationResult, FileSystemProviderCapabilities,
    FileSystemProviderErrorCode, FileType, hasFileFolderCopyCapability, hasOpenReadWriteCloseCapability, hasReadWriteCapability,
    CreateFileOptions, FileContent, FileStat, FileStatWithMetadata,
    FileStreamContent, FileSystemProvider,
    FileSystemProviderWithFileReadWriteCapability, FileSystemProviderWithOpenReadWriteCloseCapability,
    ReadFileOptions, ResolveFileOptions, ResolveMetadataFileOptions,
    Stat, WatchOptions, WriteFileOptions,
    toFileOperationResult, toFileSystemProviderErrorCode, FileSystemProviderRegistrationEvent, FileSystemProviderActivationEvent,
    FileSystemProviderCapabilitiesChangeEvent, ResolveFileResult, ResolveFileResultWithMetadata
} from '../common/files';
import { createReadStream } from '../common/io';
import { bufferToReadable, bufferToStream, streamToBuffer, TextBuffer, TextBufferReadable, TextBufferReadableStream, readableToBuffer } from '../common/buffer';
import { isReadableStream, ReadableStreamEvents, transform, consumeStreamWithLimit, consumeReadableWithLimit } from '../common/stream';
import { LabelProvider } from '@theia/core/lib/browser/label-provider';

@injectable()
export class FileService {

    private readonly BUFFER_SIZE = 64 * 1024;

    @inject(LabelProvider)
    protected readonly labelProvider: LabelProvider;

    // #region File System Provider

    private onDidChangeFileSystemProviderRegistrationsEmitter = new Emitter<FileSystemProviderRegistrationEvent>();
    readonly onDidChangeFileSystemProviderRegistrations = this.onDidChangeFileSystemProviderRegistrationsEmitter.event;

    private onWillActivateFileSystemProviderEmitter = new Emitter<FileSystemProviderActivationEvent>();
    readonly onWillActivateFileSystemProvider = this.onWillActivateFileSystemProviderEmitter.event;

    private onDidChangeFileSystemProviderCapabilitiesEmitter = new Emitter<FileSystemProviderCapabilitiesChangeEvent>();
    readonly onDidChangeFileSystemProviderCapabilities = this.onDidChangeFileSystemProviderCapabilitiesEmitter.event;

    private readonly provider = new Map<string, FileSystemProvider>();

    registerProvider(scheme: string, provider: FileSystemProvider): Disposable {
        if (this.provider.has(scheme)) {
            throw new Error(`A filesystem provider for the scheme '${scheme}' is already registered.`);
        }

        // Add provider with event
        this.provider.set(scheme, provider);
        this.onDidChangeFileSystemProviderRegistrationsEmitter.fire({ added: true, scheme, provider });

        // Forward events from provider
        const providerDisposables = new DisposableCollection();
        providerDisposables.push(provider.onDidChangeFile(changes => this.onDidFilesChangeEmitter.fire(new FileChangesEvent(changes))));
        providerDisposables.push(provider.onDidChangeCapabilities(() => this.onDidChangeFileSystemProviderCapabilitiesEmitter.fire({ provider, scheme })));

        return Disposable.create(() => {
            this.onDidChangeFileSystemProviderRegistrationsEmitter.fire({ added: false, scheme, provider });
            this.provider.delete(scheme);

            providerDisposables.dispose();
        });
    }

    async activateProvider(scheme: string): Promise<void> {

        // Emit an event that we are about to activate a provider with the given scheme.
        // Listeners can participate in the activation by registering a provider for it.
        const joiners: Promise<void>[] = [];
        this.onWillActivateFileSystemProviderEmitter.fire({
            scheme,
            join(promise) {
                if (promise) {
                    joiners.push(promise);
                }
            },
        });

        if (this.provider.has(scheme)) {
            return; // provider is already here so we can return directly
        }

        // If the provider is not yet there, make sure to join on the listeners assuming
        // that it takes a bit longer to register the file system provider.
        await Promise.all(joiners);
    }

    canHandleResource(resource: URI): boolean {
        return this.provider.has(resource.scheme);
    }

    hasCapability(resource: URI, capability: FileSystemProviderCapabilities): boolean {
        const provider = this.provider.get(resource.scheme);

        return !!(provider && (provider.capabilities & capability));
    }

    protected async withProvider(resource: URI): Promise<FileSystemProvider> {
        // Assert path is absolute
        if (!resource.path.isAbsolute) {
            throw new FileOperationError(`Unable to resolve filesystem provider with relative file path ${this.resourceForError(resource)}`, FileOperationResult.FILE_INVALID_PATH);
        }

        // Activate provider
        await this.activateProvider(resource.scheme);

        // Assert provider
        const provider = this.provider.get(resource.scheme);
        if (!provider) {
            const error = new Error();
            error.name = 'ENOPRO';
            error.message = `No file system provider found for resource ${resource.toString()}`;

            throw error;
        }

        return provider;
    }

    private async withReadProvider(resource: URI): Promise<FileSystemProviderWithFileReadWriteCapability | FileSystemProviderWithOpenReadWriteCloseCapability> {
        const provider = await this.withProvider(resource);

        if (hasOpenReadWriteCloseCapability(provider) || hasReadWriteCapability(provider)) {
            return provider;
        }

        throw new Error(`Filesystem provider for scheme '${resource.scheme}' neither has FileReadWrite, FileReadStream nor FileOpenReadWriteClose capability which is needed for the read operation.`);
    }

    private async withWriteProvider(resource: URI): Promise<FileSystemProviderWithFileReadWriteCapability | FileSystemProviderWithOpenReadWriteCloseCapability> {
        const provider = await this.withProvider(resource);
        if (hasOpenReadWriteCloseCapability(provider) || hasReadWriteCapability(provider)) {
            return provider;
        }

        throw new Error(`Filesystem provider for scheme '${resource.scheme}' neither has FileReadWrite nor FileOpenReadWriteClose capability which is needed for the write operation.`);
    }

    // #endregion

    private onDidRunOperationEmitter = new Emitter<FileOperationEvent>();
    readonly onDidRunOperation = this.onDidRunOperationEmitter.event;

    resolve(resource: URI, options: ResolveMetadataFileOptions): Promise<FileStatWithMetadata>;
    resolve(resource: URI, options?: ResolveFileOptions | undefined): Promise<FileStat>;
    async resolve(resource: any, options?: any) {
        try {
            return await this.doResolveFile(resource, options);
        } catch (error) {

            // Specially handle file not found case as file operation result
            if (toFileSystemProviderErrorCode(error) === FileSystemProviderErrorCode.FileNotFound) {
                throw new FileOperationError(`Unable to resolve non-existing file '${this.resourceForError(resource)}'`, FileOperationResult.FILE_NOT_FOUND);
            }

            // Bubble up any other error as is
            throw ensureFileSystemProviderError(error);
        }
    }

    private async doResolveFile(resource: URI, options: ResolveMetadataFileOptions): Promise<FileStatWithMetadata>;
    private async doResolveFile(resource: URI, options?: ResolveFileOptions): Promise<FileStat>;
    private async doResolveFile(resource: URI, options?: ResolveFileOptions): Promise<FileStat> {
        const provider = await this.withProvider(resource);

        const resolveTo = options?.resolveTo;
        const resolveSingleChildDescendants = options?.resolveSingleChildDescendants;
        const resolveMetadata = options?.resolveMetadata;

        const stat = await provider.stat(resource);

        let trie: TernarySearchTree<URI, boolean> | undefined;

        return this.toFileStat(provider, resource, stat, undefined, !!resolveMetadata, (stat, siblings) => {

            // lazy trie to check for recursive resolving
            if (!trie) {
                trie = TernarySearchTree.forUris<true>(!!(provider.capabilities & FileSystemProviderCapabilities.PathCaseSensitive));
                trie.set(resource, true);
                if (Array.isArray(resolveTo) && resolveTo.length) {
                    resolveTo.forEach(uri => trie!.set(uri, true));
                }
            }

            // check for recursive resolving
            if (Boolean(trie.findSuperstr(stat.resource) || trie.get(stat.resource))) {
                return true;
            }

            // check for resolving single child folders
            if (stat.isDirectory && resolveSingleChildDescendants) {
                return siblings === 1;
            }

            return false;
        });
    }

    private async toFileStat(provider: FileSystemProvider, resource: URI, stat: Stat | { type: FileType } & Partial<Stat>, siblings: number | undefined, resolveMetadata: boolean, recurse: (stat: FileStat, siblings?: number) => boolean): Promise<FileStat>;
    private async toFileStat(provider: FileSystemProvider, resource: URI, stat: Stat, siblings: number | undefined, resolveMetadata: true, recurse: (stat: FileStat, siblings?: number) => boolean): Promise<FileStatWithMetadata>;
    private async toFileStat(provider: FileSystemProvider, resource: URI, stat: Stat | { type: FileType } & Partial<Stat>, siblings: number | undefined, resolveMetadata: boolean, recurse: (stat: FileStat, siblings?: number) => boolean): Promise<FileStat> {

        // convert to file stat
        const fileStat: FileStat = {
            resource,
            name: this.labelProvider.getName(resource),
            isFile: (stat.type & FileType.File) !== 0,
            isDirectory: (stat.type & FileType.Directory) !== 0,
            isSymbolicLink: (stat.type & FileType.SymbolicLink) !== 0,
            mtime: stat.mtime,
            ctime: stat.ctime,
            size: stat.size,
            etag: etag({ mtime: stat.mtime, size: stat.size })
        };

        // check to recurse for directories
        if (fileStat.isDirectory && recurse(fileStat, siblings)) {
            try {
                const entries = await provider.readdir(resource);
                const resolvedEntries = await Promise.all(entries.map(async ([name, type]) => {
                    try {
                        const childResource = resource.resolve(name);
                        const childStat = resolveMetadata ? await provider.stat(childResource) : { type };

                        return await this.toFileStat(provider, childResource, childStat, entries.length, resolveMetadata, recurse);
                    } catch (error) {
                        console.trace(error);

                        return null; // can happen e.g. due to permission errors
                    }
                }));

                // make sure to get rid of null values that signal a failure to resolve a particular entry
                fileStat.children = resolvedEntries.filter(e => !!e) as FileStat[];
            } catch (error) {
                console.trace(error);

                fileStat.children = []; // gracefully handle errors, we may not have permissions to read
            }

            return fileStat;
        }

        return fileStat;
    }

    async resolveAll(toResolve: { resource: URI, options?: ResolveFileOptions }[]): Promise<ResolveFileResult[]>;
    async resolveAll(toResolve: { resource: URI, options: ResolveMetadataFileOptions }[]): Promise<ResolveFileResultWithMetadata[]>;
    async resolveAll(toResolve: { resource: URI; options?: ResolveFileOptions; }[]): Promise<ResolveFileResult[]> {
        return Promise.all(toResolve.map(async entry => {
            try {
                return { stat: await this.doResolveFile(entry.resource, entry.options), success: true };
            } catch (error) {
                console.trace(error);

                return { stat: undefined, success: false };
            }
        }));
    }

    async exists(resource: URI): Promise<boolean> {
        const provider = await this.withProvider(resource);

        try {
            const stat = await provider.stat(resource);

            return !!stat;
        } catch (error) {
            return false;
        }
    }

    /**
     * Tests a user's permissions for the given resource.
     */
    async access(resource: URI, mode?: number): Promise<boolean> {
        const provider = await this.withProvider(resource);

        if (!provider.access) {
            return false;
        }
        try {
            await provider.access(resource, mode);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Returns the path of the given file URI.
     *
     * USE WITH CAUTION: You should always prefer URIs to paths if possible, as they are
     * portable and platform independent. Paths should only be used in cases you directly
     * interact with the OS, e.g. when running a command on the shell.
     */
    async fsPath(resource: URI): Promise<string> {
        const provider = await this.withProvider(resource);

        if (!provider.fsPath) {
            return resource.path.toString();
        }
        return provider.fsPath(resource);
    }

    // #region File Reading/Writing

    async createFile(resource: URI, bufferOrReadableOrStream: TextBuffer | TextBufferReadable | TextBufferReadableStream = TextBuffer.fromString(''), options?: CreateFileOptions): Promise<FileStatWithMetadata> {

        // validate overwrite
        if (!options?.overwrite && await this.exists(resource)) {
            throw new FileOperationError(`Unable to create file '${this.resourceForError(resource)}' that already exists when overwrite flag is not set`, FileOperationResult.FILE_MODIFIED_SINCE, options);
        }

        // do write into file (this will create it too)
        const fileStat = await this.writeFile(resource, bufferOrReadableOrStream);

        // events
        this.onDidRunOperationEmitter.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));

        return fileStat;
    }

    async writeFile(resource: URI, bufferOrReadableOrStream: TextBuffer | TextBufferReadable | TextBufferReadableStream, options?: WriteFileOptions): Promise<FileStatWithMetadata> {
        const provider = this.throwIfFileSystemIsReadonly(await this.withWriteProvider(resource), resource);

        try {

            // validate write
            const stat = await this.validateWriteFile(provider, resource, options);

            // mkdir recursively as needed
            if (!stat) {
                await this.mkdirp(provider, resource.parent);
            }

            // optimization: if the provider has unbuffered write capability and the data
            // to write is a Readable, we consume up to 3 chunks and try to write the data
            // unbuffered to reduce the overhead. If the Readable has more data to provide
            // we continue to write buffered.
            if (hasReadWriteCapability(provider) && !(bufferOrReadableOrStream instanceof TextBuffer)) {
                if (isReadableStream(bufferOrReadableOrStream)) {
                    bufferOrReadableOrStream = await consumeStreamWithLimit(bufferOrReadableOrStream, data => TextBuffer.concat(data), 3);
                } else {
                    bufferOrReadableOrStream = consumeReadableWithLimit(bufferOrReadableOrStream, data => TextBuffer.concat(data), 3);
                }
            }

            // write file: unbuffered (only if data to write is a buffer, or the provider has no buffered write capability)
            if (!hasOpenReadWriteCloseCapability(provider) || (hasReadWriteCapability(provider) && bufferOrReadableOrStream instanceof TextBuffer)) {
                await this.doWriteUnbuffered(provider, resource, bufferOrReadableOrStream);
            }

            // write file: buffered
            else {
                await this.doWriteBuffered(provider, resource, bufferOrReadableOrStream instanceof TextBuffer ? bufferToReadable(bufferOrReadableOrStream) : bufferOrReadableOrStream);
            }
        } catch (error) {
            throw new FileOperationError(`Unable to write file '${this.resourceForError(resource)}' (${ensureFileSystemProviderError(error).toString()})`, toFileOperationResult(error), options);
        }

        return this.resolve(resource, { resolveMetadata: true });
    }

    private async validateWriteFile(provider: FileSystemProvider, resource: URI, options?: WriteFileOptions): Promise<Stat | undefined> {
        let stat: Stat | undefined = undefined;
        try {
            stat = await provider.stat(resource);
        } catch (error) {
            return undefined; // file might not exist
        }

        // file cannot be directory
        if ((stat.type & FileType.Directory) !== 0) {
            throw new FileOperationError(`Unable to write file ${this.resourceForError(resource)} that is actually a directory`, FileOperationResult.FILE_IS_DIRECTORY, options);
        }

        // Dirty write prevention: if the file on disk has been changed and does not match our expected
        // mtime and etag, we bail out to prevent dirty writing.
        //
        // First, we check for a mtime that is in the future before we do more checks. The assumption is
        // that only the mtime is an indicator for a file that has changed on disk.
        //
        // Second, if the mtime has advanced, we compare the size of the file on disk with our previous
        // one using the etag() function. Relying only on the mtime check has prooven to produce false
        // positives due to file system weirdness (especially around remote file systems). As such, the
        // check for size is a weaker check because it can return a false negative if the file has changed
        // but to the same length. This is a compromise we take to avoid having to produce checksums of
        // the file content for comparison which would be much slower to compute.
        if (
            options && typeof options.mtime === 'number' && typeof options.etag === 'string' && options.etag !== ETAG_DISABLED &&
            typeof stat.mtime === 'number' && typeof stat.size === 'number' &&
            options.mtime < stat.mtime && options.etag !== etag({ mtime: options.mtime /* not using stat.mtime for a reason, see above */, size: stat.size })
        ) {
            throw new FileOperationError('File Modified Since', FileOperationResult.FILE_MODIFIED_SINCE, options);
        }

        return stat;
    }

    async readFile(resource: URI, options?: ReadFileOptions): Promise<FileContent> {
        const provider = await this.withReadProvider(resource);

        const stream = await this.doReadAsFileStream(provider, resource, {
            ...options,
            // optimization: since we know that the caller does not
            // care about buffering, we indicate this to the reader.
            // this reduces all the overhead the buffered reading
            // has (open, read, close) if the provider supports
            // unbuffered reading.
            preferUnbuffered: true
        });

        return {
            ...stream,
            value: await streamToBuffer(stream.value)
        };
    }

    async readFileStream(resource: URI, options?: ReadFileOptions): Promise<FileStreamContent> {
        const provider = await this.withReadProvider(resource);

        return this.doReadAsFileStream(provider, resource, options);
    }

    private async doReadAsFileStream(provider: FileSystemProviderWithFileReadWriteCapability | FileSystemProviderWithOpenReadWriteCloseCapability, resource: URI, options?: ReadFileOptions & { preferUnbuffered?: boolean }): Promise<FileStreamContent> {

        // install a cancellation token that gets cancelled
        // when any error occurs. this allows us to resolve
        // the content of the file while resolving metadata
        // but still cancel the operation in certain cases.
        const cancellableSource = new CancellationTokenSource();

        // validate read operation
        const statPromise = this.validateReadFile(resource, options).then(stat => stat, error => {
            cancellableSource.cancel();

            throw error;
        });

        try {

            // if the etag is provided, we await the result of the validation
            // due to the likelyhood of hitting a NOT_MODIFIED_SINCE result.
            // otherwise, we let it run in parallel to the file reading for
            // optimal startup performance.
            if (options && typeof options.etag === 'string' && options.etag !== ETAG_DISABLED) {
                await statPromise;
            }

            let fileStreamPromise: Promise<TextBufferReadableStream>;

            // read unbuffered (only if either preferred, or the provider has no buffered read capability)
            if (!hasOpenReadWriteCloseCapability(provider) || (hasReadWriteCapability(provider) && options?.preferUnbuffered)) {
                fileStreamPromise = this.readFileUnbuffered(provider, resource, options);
            }
            // read buffered
            else {
                fileStreamPromise = Promise.resolve(this.readFileBuffered(provider, resource, cancellableSource.token, options));
            }

            const [fileStat, fileStream] = await Promise.all([statPromise, fileStreamPromise]);

            return {
                ...fileStat,
                value: fileStream
            };
        } catch (error) {
            throw new FileOperationError(`Unable to read file '${this.resourceForError(resource)}' (${ensureFileSystemProviderError(error).toString()})`, toFileOperationResult(error), options);
        }
    }

    private readFileBuffered(provider: FileSystemProviderWithOpenReadWriteCloseCapability, resource: URI, token: CancellationToken, options: ReadFileOptions = Object.create(null)): TextBufferReadableStream {
        const fileStream = createReadStream(provider, resource, {
            ...options,
            bufferSize: this.BUFFER_SIZE
        }, token);

        return this.transformFileReadStream(resource, fileStream, options);
    }

    private transformFileReadStream(resource: URI, stream: ReadableStreamEvents<Uint8Array | TextBuffer>, options: ReadFileOptions): TextBufferReadableStream {
        return transform(stream, {
            data: data => data instanceof TextBuffer ? data : TextBuffer.wrap(data),
            error: error => new FileOperationError(`Unable to read file '${this.resourceForError(resource)}' (${ensureFileSystemProviderError(error).toString()})`, toFileOperationResult(error), options)
        }, data => TextBuffer.concat(data));
    }

    private async readFileUnbuffered(provider: FileSystemProviderWithFileReadWriteCapability, resource: URI, options?: ReadFileOptions): Promise<TextBufferReadableStream> {
        let buffer = await provider.readFile(resource);

        // respect position option
        if (options && typeof options.position === 'number') {
            buffer = buffer.slice(options.position);
        }

        // respect length option
        if (options && typeof options.length === 'number') {
            buffer = buffer.slice(0, options.length);
        }

        return bufferToStream(TextBuffer.wrap(buffer));
    }

    private async validateReadFile(resource: URI, options?: ReadFileOptions): Promise<FileStatWithMetadata> {
        const stat = await this.resolve(resource, { resolveMetadata: true });

        // Throw if resource is a directory
        if (stat.isDirectory) {
            throw new FileOperationError(`Unable to read file '${this.resourceForError(resource)}' that is actually a directory`, FileOperationResult.FILE_IS_DIRECTORY, options);
        }

        // Throw if file not modified since (unless disabled)
        if (options && typeof options.etag === 'string' && options.etag !== ETAG_DISABLED && options.etag === stat.etag) {
            throw new FileOperationError('File not modified since', FileOperationResult.FILE_NOT_MODIFIED_SINCE, options);
        }

        return stat;
    }

    // #endregion

    // #region Move/Copy/Delete/Create Folder

    async move(source: URI, target: URI, overwrite?: boolean): Promise<FileStatWithMetadata> {
        const sourceProvider = this.throwIfFileSystemIsReadonly(await this.withWriteProvider(source), source);
        const targetProvider = this.throwIfFileSystemIsReadonly(await this.withWriteProvider(target), target);

        // move
        const mode = await this.doMoveCopy(sourceProvider, source, targetProvider, target, 'move', !!overwrite);

        // resolve and send events
        const fileStat = await this.resolve(target, { resolveMetadata: true });
        this.onDidRunOperationEmitter.fire(new FileOperationEvent(source, mode === 'move' ? FileOperation.MOVE : FileOperation.COPY, fileStat));

        return fileStat;
    }

    async copy(source: URI, target: URI, overwrite?: boolean): Promise<FileStatWithMetadata> {
        const sourceProvider = await this.withReadProvider(source);
        const targetProvider = this.throwIfFileSystemIsReadonly(await this.withWriteProvider(target), target);

        // copy
        const mode = await this.doMoveCopy(sourceProvider, source, targetProvider, target, 'copy', !!overwrite);

        // resolve and send events
        const fileStat = await this.resolve(target, { resolveMetadata: true });
        this.onDidRunOperationEmitter.fire(new FileOperationEvent(source, mode === 'copy' ? FileOperation.COPY : FileOperation.MOVE, fileStat));

        return fileStat;
    }

    private async doMoveCopy(sourceProvider: FileSystemProvider, source: URI, targetProvider: FileSystemProvider, target: URI, mode: 'move' | 'copy', overwrite: boolean): Promise<'move' | 'copy'> {
        if (source.toString() === target.toString()) {
            return mode; // simulate node.js behaviour here and do a no-op if paths match
        }

        // validation
        const { exists, isSameResourceWithDifferentPathCase } = await this.doValidateMoveCopy(sourceProvider, source, targetProvider, target, mode, overwrite);

        // delete as needed (unless target is same resurce with different path case)
        if (exists && !isSameResourceWithDifferentPathCase && overwrite) {
            await this.del(target, { recursive: true });
        }

        // create parent folders
        await this.mkdirp(targetProvider, target.parent);

        // copy source => target
        if (mode === 'copy') {

            // same provider with fast copy: leverage copy() functionality
            if (sourceProvider === targetProvider && hasFileFolderCopyCapability(sourceProvider)) {
                await sourceProvider.copy(source, target, { overwrite });
            }

            // when copying via buffer/unbuffered, we have to manually
            // traverse the source if it is a folder and not a file
            else {
                const sourceFile = await this.resolve(source);
                if (sourceFile.isDirectory) {
                    await this.doCopyFolder(sourceProvider, sourceFile, targetProvider, target);
                } else {
                    await this.doCopyFile(sourceProvider, source, targetProvider, target);
                }
            }

            return mode;
        }

        // move source => target
        else {

            // same provider: leverage rename() functionality
            if (sourceProvider === targetProvider) {
                await sourceProvider.rename(source, target, { overwrite });

                return mode;
            }

            // across providers: copy to target & delete at source
            else {
                await this.doMoveCopy(sourceProvider, source, targetProvider, target, 'copy', overwrite);

                await this.del(source, { recursive: true });

                return 'copy';
            }
        }
    }

    private async doCopyFile(sourceProvider: FileSystemProvider, source: URI, targetProvider: FileSystemProvider, target: URI): Promise<void> {

        // copy: source (buffered) => target (buffered)
        if (hasOpenReadWriteCloseCapability(sourceProvider) && hasOpenReadWriteCloseCapability(targetProvider)) {
            return this.doPipeBuffered(sourceProvider, source, targetProvider, target);
        }

        // copy: source (buffered) => target (unbuffered)
        if (hasOpenReadWriteCloseCapability(sourceProvider) && hasReadWriteCapability(targetProvider)) {
            return this.doPipeBufferedToUnbuffered(sourceProvider, source, targetProvider, target);
        }

        // copy: source (unbuffered) => target (buffered)
        if (hasReadWriteCapability(sourceProvider) && hasOpenReadWriteCloseCapability(targetProvider)) {
            return this.doPipeUnbufferedToBuffered(sourceProvider, source, targetProvider, target);
        }

        // copy: source (unbuffered) => target (unbuffered)
        if (hasReadWriteCapability(sourceProvider) && hasReadWriteCapability(targetProvider)) {
            return this.doPipeUnbuffered(sourceProvider, source, targetProvider, target);
        }
    }

    private async doCopyFolder(sourceProvider: FileSystemProvider, sourceFolder: FileStat, targetProvider: FileSystemProvider, targetFolder: URI): Promise<void> {

        // create folder in target
        await targetProvider.mkdir(targetFolder);

        // create children in target
        if (Array.isArray(sourceFolder.children)) {
            await Promise.all(sourceFolder.children.map(async sourceChild => {
                const targetChild = targetFolder.resolve(sourceChild.name);
                if (sourceChild.isDirectory) {
                    return this.doCopyFolder(sourceProvider, await this.resolve(sourceChild.resource), targetProvider, targetChild);
                } else {
                    return this.doCopyFile(sourceProvider, sourceChild.resource, targetProvider, targetChild);
                }
            }));
        }
    }

    private async doValidateMoveCopy(sourceProvider: FileSystemProvider, source: URI, targetProvider: FileSystemProvider, target: URI, mode: 'move' | 'copy', overwrite?: boolean): Promise<{ exists: boolean, isSameResourceWithDifferentPathCase: boolean }> {
        let isSameResourceWithDifferentPathCase = false;

        // Check if source is equal or parent to target (requires providers to be the same)
        if (sourceProvider === targetProvider) {
            const isPathCaseSensitive = !!(sourceProvider.capabilities & FileSystemProviderCapabilities.PathCaseSensitive);
            if (!isPathCaseSensitive) {
                isSameResourceWithDifferentPathCase = source.toString().toLowerCase() === target.toString().toLowerCase();
            }

            if (isSameResourceWithDifferentPathCase && mode === 'copy') {
                throw new Error(`Unable to copy when source '${this.resourceForError(source)}' is same as target '${this.resourceForError(target)}' with different path case on a case insensitive file system`);
            }

            if (!isSameResourceWithDifferentPathCase && target.isEqualOrParent(source, isPathCaseSensitive)) {
                throw new Error(`Unable to move/copy when source '${this.resourceForError(source)}' is parent of target '${this.resourceForError(target)}'.`);
            }
        }

        // Extra checks if target exists and this is not a rename
        const exists = await this.exists(target);
        if (exists && !isSameResourceWithDifferentPathCase) {

            // Bail out if target exists and we are not about to overwrite
            if (!overwrite) {
                throw new FileOperationError(`Unable to move/copy '${this.resourceForError(source)}' because target '${this.resourceForError(target)}' already exists at destination.`, FileOperationResult.FILE_MOVE_CONFLICT);
            }

            // Special case: if the target is a parent of the source, we cannot delete
            // it as it would delete the source as well. In this case we have to throw
            if (sourceProvider === targetProvider) {
                const isPathCaseSensitive = !!(sourceProvider.capabilities & FileSystemProviderCapabilities.PathCaseSensitive);
                if (source.isEqualOrParent(target, isPathCaseSensitive)) {
                    throw new Error(`Unable to move/copy '${this.resourceForError(source)}' into '${this.resourceForError(target)}' since a file would replace the folder it is contained in.`);
                }
            }
        }

        return { exists, isSameResourceWithDifferentPathCase };
    }

    async createFolder(resource: URI): Promise<FileStatWithMetadata> {
        const provider = this.throwIfFileSystemIsReadonly(await this.withProvider(resource), resource);

        // mkdir recursively
        await this.mkdirp(provider, resource);

        // events
        const fileStat = await this.resolve(resource, { resolveMetadata: true });
        this.onDidRunOperationEmitter.fire(new FileOperationEvent(resource, FileOperation.CREATE, fileStat));

        return fileStat;
    }

    private async mkdirp(provider: FileSystemProvider, directory: URI): Promise<void> {
        const directoriesToCreate: string[] = [];

        // mkdir until we reach root
        while (!directory.path.isRoot) {
            try {
                const stat = await provider.stat(directory);
                if ((stat.type & FileType.Directory) === 0) {
                    throw new Error(`Unable to create folder ${this.resourceForError(directory)} that already exists but is not a directory`);
                }

                break; // we have hit a directory that exists -> good
            } catch (error) {

                // Bubble up any other error that is not file not found
                if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileNotFound) {
                    throw error;
                }

                // Upon error, remember directories that need to be created
                directoriesToCreate.push(directory.path.base);

                // Continue up
                directory = directory.parent;
            }
        }

        // Create directories as needed
        for (let i = directoriesToCreate.length - 1; i >= 0; i--) {
            directory = directory.resolve(directoriesToCreate[i]);

            try {
                await provider.mkdir(directory);
            } catch (error) {
                if (toFileSystemProviderErrorCode(error) !== FileSystemProviderErrorCode.FileExists) {
                    // For mkdirp() we tolerate that the mkdir() call fails
                    // in case the folder already exists. This follows node.js
                    // own implementation of fs.mkdir({ recursive: true }) and
                    // reduces the chances of race conditions leading to errors
                    // if multiple calls try to create the same folders
                    // As such, we only throw an error here if it is other than
                    // the fact that the file already exists.
                    // (see also https://github.com/microsoft/vscode/issues/89834)
                    throw error;
                }
            }
        }
    }

    async del(resource: URI, options?: { useTrash?: boolean; recursive?: boolean; }): Promise<void> {
        const provider = this.throwIfFileSystemIsReadonly(await this.withProvider(resource), resource);

        // Validate trash support
        const useTrash = !!options?.useTrash;
        if (useTrash && !(provider.capabilities & FileSystemProviderCapabilities.Trash)) {
            throw new Error(`Unable to delete file '${this.resourceForError(resource)}' via trash because provider does not support it.`);
        }

        // Validate delete
        const exists = await this.exists(resource);
        if (!exists) {
            throw new FileOperationError(`Unable to delete non-existing file '${this.resourceForError(resource)}'`, FileOperationResult.FILE_NOT_FOUND);
        }

        // Validate recursive
        const recursive = !!options?.recursive;
        if (!recursive && exists) {
            const stat = await this.resolve(resource);
            if (stat.isDirectory && Array.isArray(stat.children) && stat.children.length > 0) {
                throw new Error(`Unable to delete non-empty folder '${this.resourceForError(resource)}'.`);
            }
        }

        // Delete through provider
        await provider.delete(resource, { recursive, useTrash });

        // Events
        this.onDidRunOperationEmitter.fire(new FileOperationEvent(resource, FileOperation.DELETE));
    }

    // #endregion

    // #region File Watching

    private onDidFilesChangeEmitter = new Emitter<FileChangesEvent>();
    readonly onDidFilesChange = this.onDidFilesChangeEmitter.event;

    private activeWatchers = new Map<string, { disposable: Disposable, count: number }>();

    watch(resource: URI, options: WatchOptions = { recursive: false, excludes: [] }): Disposable {
        let watchDisposed = false;
        let watchDisposable = Disposable.create(() => watchDisposed = true);

        // Watch and wire in disposable which is async but
        // check if we got disposed meanwhile and forward
        this.doWatch(resource, options).then(disposable => {
            if (watchDisposed) {
                disposable.dispose();
            } else {
                watchDisposable = disposable;
            }
        }, error => console.error(error));

        return Disposable.create(() => watchDisposable.dispose());
    }

    async doWatch(resource: URI, options: WatchOptions): Promise<Disposable> {
        const provider = await this.withProvider(resource);
        const key = this.toWatchKey(provider, resource, options);

        // Only start watching if we are the first for the given key
        const watcher = this.activeWatchers.get(key) || { count: 0, disposable: provider.watch(resource, options) };
        if (!this.activeWatchers.has(key)) {
            this.activeWatchers.set(key, watcher);
        }

        // Increment usage counter
        watcher.count += 1;

        return Disposable.create(() => {

            // Unref
            watcher.count--;

            // Dispose only when last user is reached
            if (watcher.count === 0) {
                watcher.disposable.dispose();
                this.activeWatchers.delete(key);
            }
        });
    }

    private toWatchKey(provider: FileSystemProvider, resource: URI, options: WatchOptions): string {
        return [
            this.toMapKey(provider, resource), 	// lowercase path if the provider is case insensitive
            String(options.recursive),			// use recursive: true | false as part of the key
            options.excludes.join()				// use excludes as part of the key
        ].join();
    }

    // #endregion

    // #region Helpers

    private writeQueues: Map<string, Promise<void>> = new Map();

    private ensureWriteQueue(provider: FileSystemProvider, resource: URI, task: () => Promise<void>): Promise<void> {
        // ensure to never write to the same resource without finishing
        // the one write. this ensures a write finishes consistently
        // (even with error) before another write is done.
        const queueKey = this.toMapKey(provider, resource);
        const writeQueue = (this.writeQueues.get(queueKey) || Promise.resolve()).then(task, task);
        this.writeQueues.set(queueKey, writeQueue);
        return writeQueue;
    }

    private toMapKey(provider: FileSystemProvider, resource: URI): string {
        const isPathCaseSensitive = !!(provider.capabilities & FileSystemProviderCapabilities.PathCaseSensitive);

        return isPathCaseSensitive ? resource.toString() : resource.toString().toLowerCase();
    }

    private async doWriteBuffered(provider: FileSystemProviderWithOpenReadWriteCloseCapability, resource: URI, readableOrStream: TextBufferReadable | TextBufferReadableStream): Promise<void> {
        return this.ensureWriteQueue(provider, resource, async () => {

            // open handle
            const handle = await provider.open(resource, { create: true });

            // write into handle until all bytes from buffer have been written
            try {
                if (isReadableStream(readableOrStream)) {
                    await this.doWriteStreamBufferedQueued(provider, handle, readableOrStream);
                } else {
                    await this.doWriteReadableBufferedQueued(provider, handle, readableOrStream);
                }
            } catch (error) {
                throw ensureFileSystemProviderError(error);
            } finally {

                // close handle always
                await provider.close(handle);
            }
        });
    }

    private doWriteStreamBufferedQueued(provider: FileSystemProviderWithOpenReadWriteCloseCapability, handle: number, stream: TextBufferReadableStream): Promise<void> {
        return new Promise((resolve, reject) => {
            let posInFile = 0;

            stream.on('data', async chunk => {

                // pause stream to perform async write operation
                stream.pause();

                try {
                    await this.doWriteBuffer(provider, handle, chunk, chunk.byteLength, posInFile, 0);
                } catch (error) {
                    return reject(error);
                }

                posInFile += chunk.byteLength;

                // resume stream now that we have successfully written
                // run this on the next tick to prevent increasing the
                // execution stack because resume() may call the event
                // handler again before finishing.
                setTimeout(() => stream.resume());
            });

            stream.on('error', error => reject(error));
            stream.on('end', () => resolve());
        });
    }

    private async doWriteReadableBufferedQueued(provider: FileSystemProviderWithOpenReadWriteCloseCapability, handle: number, readable: TextBufferReadable): Promise<void> {
        let posInFile = 0;

        let chunk: TextBuffer | null;
        while ((chunk = readable.read()) !== null) {
            await this.doWriteBuffer(provider, handle, chunk, chunk.byteLength, posInFile, 0);

            posInFile += chunk.byteLength;
        }
    }

    private async doWriteBuffer(provider: FileSystemProviderWithOpenReadWriteCloseCapability, handle: number, buffer: TextBuffer, length: number, posInFile: number, posInBuffer: number): Promise<void> {
        let totalBytesWritten = 0;
        while (totalBytesWritten < length) {
            const bytesWritten = await provider.write(handle, posInFile + totalBytesWritten, buffer.buffer, posInBuffer + totalBytesWritten, length - totalBytesWritten);
            totalBytesWritten += bytesWritten;
        }
    }

    private async doWriteUnbuffered(provider: FileSystemProviderWithFileReadWriteCapability, resource: URI, bufferOrReadableOrStream: TextBuffer | TextBufferReadable | TextBufferReadableStream): Promise<void> {
        return this.ensureWriteQueue(provider, resource, () => this.doWriteUnbufferedQueued(provider, resource, bufferOrReadableOrStream));
    }

    private async doWriteUnbufferedQueued(provider: FileSystemProviderWithFileReadWriteCapability, resource: URI, bufferOrReadableOrStream: TextBuffer | TextBufferReadable | TextBufferReadableStream): Promise<void> {
        let buffer: TextBuffer;
        if (bufferOrReadableOrStream instanceof TextBuffer) {
            buffer = bufferOrReadableOrStream;
        } else if (isReadableStream(bufferOrReadableOrStream)) {
            buffer = await streamToBuffer(bufferOrReadableOrStream);
        } else {
            buffer = readableToBuffer(bufferOrReadableOrStream);
        }

        return provider.writeFile(resource, buffer.buffer, { create: true, overwrite: true });
    }

    private async doPipeBuffered(sourceProvider: FileSystemProviderWithOpenReadWriteCloseCapability, source: URI, targetProvider: FileSystemProviderWithOpenReadWriteCloseCapability, target: URI): Promise<void> {
        return this.ensureWriteQueue(targetProvider, target, () => this.doPipeBufferedQueued(sourceProvider, source, targetProvider, target));
    }

    private async doPipeBufferedQueued(sourceProvider: FileSystemProviderWithOpenReadWriteCloseCapability, source: URI, targetProvider: FileSystemProviderWithOpenReadWriteCloseCapability, target: URI): Promise<void> {
        let sourceHandle: number | undefined = undefined;
        let targetHandle: number | undefined = undefined;

        try {

            // Open handles
            sourceHandle = await sourceProvider.open(source, { create: false });
            targetHandle = await targetProvider.open(target, { create: true });

            const buffer = TextBuffer.alloc(this.BUFFER_SIZE);

            let posInFile = 0;
            let posInBuffer = 0;
            let bytesRead = 0;
            do {
                // read from source (sourceHandle) at current position (posInFile) into buffer (buffer) at
                // buffer position (posInBuffer) up to the size of the buffer (buffer.byteLength).
                bytesRead = await sourceProvider.read(sourceHandle, posInFile, buffer.buffer, posInBuffer, buffer.byteLength - posInBuffer);

                // write into target (targetHandle) at current position (posInFile) from buffer (buffer) at
                // buffer position (posInBuffer) all bytes we read (bytesRead).
                await this.doWriteBuffer(targetProvider, targetHandle, buffer, bytesRead, posInFile, posInBuffer);

                posInFile += bytesRead;
                posInBuffer += bytesRead;

                // when buffer full, fill it again from the beginning
                if (posInBuffer === buffer.byteLength) {
                    posInBuffer = 0;
                }
            } while (bytesRead > 0);
        } catch (error) {
            throw ensureFileSystemProviderError(error);
        } finally {
            await Promise.all([
                typeof sourceHandle === 'number' ? sourceProvider.close(sourceHandle) : Promise.resolve(),
                typeof targetHandle === 'number' ? targetProvider.close(targetHandle) : Promise.resolve(),
            ]);
        }
    }

    private async doPipeUnbuffered(sourceProvider: FileSystemProviderWithFileReadWriteCapability, source: URI, targetProvider: FileSystemProviderWithFileReadWriteCapability, target: URI): Promise<void> {
        return this.ensureWriteQueue(targetProvider, target, () => this.doPipeUnbufferedQueued(sourceProvider, source, targetProvider, target));
    }

    private async doPipeUnbufferedQueued(sourceProvider: FileSystemProviderWithFileReadWriteCapability, source: URI, targetProvider: FileSystemProviderWithFileReadWriteCapability, target: URI): Promise<void> {
        return targetProvider.writeFile(target, await sourceProvider.readFile(source), { create: true, overwrite: true });
    }

    private async doPipeUnbufferedToBuffered(sourceProvider: FileSystemProviderWithFileReadWriteCapability, source: URI, targetProvider: FileSystemProviderWithOpenReadWriteCloseCapability, target: URI): Promise<void> {
        return this.ensureWriteQueue(targetProvider, target, () => this.doPipeUnbufferedToBufferedQueued(sourceProvider, source, targetProvider, target));
    }

    private async doPipeUnbufferedToBufferedQueued(sourceProvider: FileSystemProviderWithFileReadWriteCapability, source: URI, targetProvider: FileSystemProviderWithOpenReadWriteCloseCapability, target: URI): Promise<void> {

        // Open handle
        const targetHandle = await targetProvider.open(target, { create: true });

        // Read entire buffer from source and write buffered
        try {
            const buffer = await sourceProvider.readFile(source);
            await this.doWriteBuffer(targetProvider, targetHandle, TextBuffer.wrap(buffer), buffer.byteLength, 0, 0);
        } catch (error) {
            throw ensureFileSystemProviderError(error);
        } finally {
            await targetProvider.close(targetHandle);
        }
    }

    private async doPipeBufferedToUnbuffered(sourceProvider: FileSystemProviderWithOpenReadWriteCloseCapability, source: URI, targetProvider: FileSystemProviderWithFileReadWriteCapability, target: URI): Promise<void> {

        // Read buffer via stream buffered
        const buffer = await streamToBuffer(this.readFileBuffered(sourceProvider, source, CancellationToken.None));

        // Write buffer into target at once
        await this.doWriteUnbuffered(targetProvider, target, buffer);
    }

    protected throwIfFileSystemIsReadonly<T extends FileSystemProvider>(provider: T, resource: URI): T {
        if (provider.capabilities & FileSystemProviderCapabilities.Readonly) {
            throw new FileOperationError(`Unable to modify readonly file ${this.resourceForError(resource)}`, FileOperationResult.FILE_PERMISSION_DENIED);
        }

        return provider;
    }

    private resourceForError(resource: URI): string {
        return this.labelProvider.getLongName(resource);
    }

    // #endregion

}
