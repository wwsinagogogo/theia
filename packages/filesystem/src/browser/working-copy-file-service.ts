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

import { injectable, inject } from 'inversify';
import URI from '@theia/core/lib/common/uri';
import { timeout } from '@theia/core/lib/common/promise-util';
import { WaitUntilEvent, Emitter } from '@theia/core/lib/common/event';
import { Disposable } from '@theia/core/lib/common/disposable';
import { CancellationTokenSource, CancellationToken } from '@theia/core/lib/common/cancellation';
import { ProgressService } from '@theia/core/lib/common/progress-service';
import { FileStatWithMetadata, FileOperation, CreateFileOptions } from '../common/files';
import { FileService } from './file-service';
import { EncodingService, WriteTextFileOptions } from './encoding-service';
import { FileSystemPreferences } from './filesystem-preferences';
import { TextBuffer } from '../common/buffer';

export interface WorkingCopyFileEvent extends WaitUntilEvent {

	/**
	 * An identifier to correlate the operation through the
	 * different event types (before, after, error).
	 */
    readonly correlationId: number;

	/**
	 * The file operation that is taking place.
	 */
    readonly operation: FileOperation;

	/**
	 * The resource the event is about.
	 */
    readonly target: URI;

	/**
	 * A property that is defined for move operations.
	 */
    readonly source?: URI;
}

export interface WorkingCopyFileOperationParticipant {

	/**
	 * Participate in a file operation of a working copy. Allows to
	 * change the working copy before it is being saved to disk.
	 */
    participate(
        target: URI,
        source: URI | undefined,
        operation: FileOperation,
        timeout: number,
        token: CancellationToken
    ): Promise<void>;
}

@injectable()
export class WorkingCopyFileService {

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(EncodingService)
    protected readonly encodingService: EncodingService;

    @inject(FileSystemPreferences)
    protected readonly preferences: FileSystemPreferences;

    @inject(ProgressService)
    protected readonly progressService: ProgressService;

    // #region Events

    private readonly onWillRunWorkingCopyFileOperationEmitter = new Emitter<WorkingCopyFileEvent>();
    readonly onWillRunWorkingCopyFileOperation = this.onWillRunWorkingCopyFileOperationEmitter.event;

    private readonly onDidFailWorkingCopyFileOperationEmitter = new Emitter<WorkingCopyFileEvent>();
    readonly onDidFailWorkingCopyFileOperation = this.onDidFailWorkingCopyFileOperationEmitter.event;

    private readonly onDidRunWorkingCopyFileOperationEmitter = new Emitter<WorkingCopyFileEvent>();
    readonly onDidRunWorkingCopyFileOperation = this.onDidRunWorkingCopyFileOperationEmitter.event;

    // #endregion

    private correlationIds = 0;

    async create(resource: URI, value?: string, options?: CreateFileOptions): Promise<FileStatWithMetadata> {
        await this.runFileOperationParticipants(resource, undefined, FileOperation.CREATE);

        const event = { correlationId: this.correlationIds++, operation: FileOperation.CREATE, target: resource };
        await WaitUntilEvent.fireAsync(this.onWillRunWorkingCopyFileOperationEmitter, event);

        let stat: FileStatWithMetadata;
        try {
            stat = await this.fileService.createFile(resource, typeof value === 'string' ? TextBuffer.fromString(value) : undefined, options);
        } catch (error) {
            await WaitUntilEvent.fireAsync(this.onDidFailWorkingCopyFileOperationEmitter, event);
            throw error;
        }

        await WaitUntilEvent.fireAsync(this.onDidRunWorkingCopyFileOperationEmitter, event);

        return stat;
    }

    async write(resource: URI, value: string, options?: WriteTextFileOptions): Promise<FileStatWithMetadata> {
        const encoding = await this.encodingService.getWriteEncoding(resource, options);
        const encoded = this.encodingService.encode(value, encoding);
        return this.fileService.writeFile(resource, encoded, options);
    }

    async move(source: URI, target: URI, overwrite?: boolean): Promise<FileStatWithMetadata> {
        return this.moveOrCopy(source, target, true, overwrite);
    }

    async copy(source: URI, target: URI, overwrite?: boolean): Promise<FileStatWithMetadata> {
        return this.moveOrCopy(source, target, false, overwrite);
    }

    private async moveOrCopy(source: URI, target: URI, move: boolean, overwrite?: boolean): Promise<FileStatWithMetadata> {
        await this.runFileOperationParticipants(target, source, move ? FileOperation.MOVE : FileOperation.COPY);

        const event = { correlationId: this.correlationIds++, operation: move ? FileOperation.MOVE : FileOperation.COPY, target, source };
        await WaitUntilEvent.fireAsync(this.onWillRunWorkingCopyFileOperationEmitter, event);
        let stat: FileStatWithMetadata;
        try {
            if (move) {
                stat = await this.fileService.move(source, target, overwrite);
            } else {
                stat = await this.fileService.copy(source, target, overwrite);
            }
        } catch (error) {
            await WaitUntilEvent.fireAsync(this.onDidFailWorkingCopyFileOperationEmitter, event);
            throw error;
        }

        await WaitUntilEvent.fireAsync(this.onDidRunWorkingCopyFileOperationEmitter, event);
        return stat;
    }

    async delete(resource: URI, options?: { useTrash?: boolean, recursive?: boolean }): Promise<void> {
        await this.runFileOperationParticipants(resource, undefined, FileOperation.DELETE);

        const event = { correlationId: this.correlationIds++, operation: FileOperation.DELETE, target: resource };
        await WaitUntilEvent.fireAsync(this.onWillRunWorkingCopyFileOperationEmitter, event);

        try {
            await this.fileService.del(resource, options);
        } catch (error) {
            await WaitUntilEvent.fireAsync(this.onDidFailWorkingCopyFileOperationEmitter, event);
            throw error;
        }

        await WaitUntilEvent.fireAsync(this.onDidRunWorkingCopyFileOperationEmitter, event);
    }

    // #region File operation participants

    private readonly participants: WorkingCopyFileOperationParticipant[] = [];

    addFileOperationParticipant(participant: WorkingCopyFileOperationParticipant): Disposable {
        this.participants.push(participant);

        return Disposable.create(() => {
            const index = this.participants.indexOf(participant);
            if (index > -1) {
                this.participants.splice(index, 1);
            }
        });
    }

    async runFileOperationParticipants(target: URI, source: URI | undefined, operation: FileOperation): Promise<void> {
        const participantsTimeout = this.preferences['files.participants.timeout'];
        if (participantsTimeout <= 0) {
            return;
        }

        const cancellationTokenSource = new CancellationTokenSource();

        return this.progressService.withProgress(this.progressLabel(operation), 'window', async () => {
            for (const participant of this.participants) {
                if (cancellationTokenSource.token.isCancellationRequested) {
                    break;
                }

                try {
                    const promise = participant.participate(target, source, operation, participantsTimeout, cancellationTokenSource.token);
                    await Promise.race([
                        promise,
                        timeout(participantsTimeout, cancellationTokenSource.token).then(() => cancellationTokenSource.dispose(), () => { /* no-op if cancelled */ })
                    ]);
                } catch (err) {
                    console.warn(err);
                }
            }
        });
    }

    private progressLabel(operation: FileOperation): string {
        switch (operation) {
            case FileOperation.CREATE:
                return "Running 'File Create' participants...";
            case FileOperation.MOVE:
                return "Running 'File Rename' participants...";
            case FileOperation.COPY:
                return "Running 'File Copy' participants...";
            case FileOperation.DELETE:
                return "Running 'File Delete' participants...";
        }
    }

    // #endregion

}
