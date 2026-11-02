import { remoteConfigSchema } from '@bplaylist/shared';
import { Http, action, alert, confirm, prompt, inputType } from '@nativescript/core';

import { call } from './host.ts';

export async function cloud(playlistId: string, importArchive: (archive: unknown) => void) {
  const endpoint = await prompt({
    title: '云端服务 HTTPS 地址',
    okButtonText: '下一步',
    cancelButtonText: '取消',
  });

  if (!endpoint.result) {
    return;
  }

  const secret = await prompt({
    title: '访问密钥',
    inputType: inputType.password,
    okButtonText: '下一步',
    cancelButtonText: '取消',
  });

  if (!secret.result) {
    return;
  }

  const operation = await action({
    title: '云端同步',
    actions: ['上传当前列表', '从云端导入'],
    cancelButtonText: '取消',
  });

  if (operation === '取消') {
    return;
  }

  try {
    const config = remoteConfigSchema.parse({ endpoint: endpoint.text, token: secret.text });
    const root = config.endpoint.replace(/\/$/, '');

    if (operation === '上传当前列表') {
      await upload(root, config.token, playlistId);
    } else {
      await download(root, config.token, importArchive);
    }
  } catch (cause) {
    await alert(String(cause));
  }
}

async function upload(root: string, token: string, playlistId: string) {
  const url = `${root}/playlists/${playlistId}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const current = await Http.request({ url, method: 'GET', headers });

  if (current.statusCode !== 404 && current.statusCode >= 400) {
    throw new Error('无法读取云端版本');
  }

  const expectedRevision =
    current.statusCode === 404 ? 0 : (current.content!.toJSON() as { revision: number }).revision;

  if (
    expectedRevision > 0 &&
    !(await confirm({
      title: '覆盖云端播放列表？',
      message: '将使用当前列表和进度更新云端版本。',
      okButtonText: '上传',
      cancelButtonText: '取消',
    }))
  ) {
    return;
  }

  const response = await Http.request({
    url,
    method: 'PUT',
    headers,
    content: JSON.stringify({ expectedRevision, archive: call('export') }),
  });

  if (response.statusCode >= 400) {
    throw new Error(response.content?.toString() || '上传失败');
  }

  await alert('上传完成');
}

async function download(root: string, token: string, importArchive: (archive: unknown) => void) {
  const result = await prompt({
    title: '云端播放列表 ID',
    okButtonText: '导入',
    cancelButtonText: '取消',
  });

  if (!result.result) {
    return;
  }

  const response = await Http.request({
    url: `${root}/playlists/${encodeURIComponent(result.text)}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (response.statusCode >= 400) {
    throw new Error('读取失败');
  }

  importArchive((response.content!.toJSON() as { archive: unknown }).archive);
}
