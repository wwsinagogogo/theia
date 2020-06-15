/********************************************************************************
 * Copyright (C) 2018 Ericsson and others.
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

import URI from '@theia/core/lib/common/uri';
import { injectable, inject } from 'inversify';
import { WorkspaceUtils } from './workspace-utils';
import { WorkspaceService } from './workspace-service';
import { UriCommandHandler } from '@theia/core/lib/common/uri-command-handler';
import { FileSystemUtils } from '@theia/filesystem/lib/common/filesystem-utils';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { WorkingCopyFileService } from '@theia/filesystem/lib/browser/working-copy-file-service';

@injectable()
export class WorkspaceDuplicateHandler implements UriCommandHandler<URI[]> {

    @inject(FileService)
    protected readonly fileService: FileService;

    @inject(WorkingCopyFileService)
    protected readonly workingCopyFileService: WorkingCopyFileService;

    @inject(WorkspaceUtils)
    protected readonly workspaceUtils: WorkspaceUtils;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    /**
     * Determine if the command is visible.
     *
     * @param uris URIs of selected resources.
     * @returns `true` if the command is visible.
     */
    isVisible(uris: URI[]): boolean {
        return !!uris.length && !this.workspaceUtils.containsRootDirectory(uris);
    }

    /**
     * Determine if the command is enabled.
     *
     * @param uris URIs of selected resources.
     * @returns `true` if the command is enabled.
     */
    isEnabled(uris: URI[]): boolean {
        return !!uris.length && !this.workspaceUtils.containsRootDirectory(uris);
    }

    /**
     * Execute the command.
     *
     * @param uris URIs of selected resources.
     */
    async execute(uris: URI[]): Promise<void> {
        await Promise.all(uris.map(async uri => {
            const parent = await this.fileService.resolve(uri.parent, { resolveSingleChildDescendants: true, resolveMetadata: false });
            if (parent) {
                const parentUri = parent.resource;
                const name = uri.path.name + '_copy';
                const ext = uri.path.ext;
                const target = FileSystemUtils.generateUniqueResourceURI(parentUri, parent, name, ext);
                try {
                    this.workingCopyFileService.copy(uri, target);
                } catch (e) {
                    console.error(e);
                }
            }
        }));
    }

}
