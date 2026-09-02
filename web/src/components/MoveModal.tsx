// 移动/复制目标选择弹窗：从根目录逐级浏览
import { useEffect, useState } from 'react';
import { Modal, Tree, message, Button, Space, Typography } from 'antd';
import { FolderOutlined } from '@ant-design/icons';
import { filesApi, orgApi } from '../api';
import type { FileItem, OrgRoot } from '../api/types';

interface Props {
  open: boolean;
  mode: 'move' | 'copy';
  onCancel: () => void;
  /** 确认目标；返回 promise 期间按钮保持 loading 并防重入（重复点击不重复提交） */
  onConfirm: (targetDirId: string) => Promise<void>;
}

interface TreeNode {
  key: string;
  title: string;
  isLeaf?: boolean;
  children?: TreeNode[];
}

export default function MoveModal({ open, mode, onCancel, onConfirm }: Props) {
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected('');
    setConfirming(false);
    setLoading(true);
    orgApi
      .roots()
      .then((r) => {
        const roots: TreeNode[] = r.roots.map((root: OrgRoot) => ({ key: root.id, title: root.name, isLeaf: false, children: [] }));
        setTreeData(roots);
        if (roots.length === 1) setSelected(roots[0].key);
      })
      .catch((e) => message.error((e as Error).message))
      .finally(() => setLoading(false));
  }, [open]);

  const loadChildren = async (node: TreeNode): Promise<TreeNode[]> => {
    try {
      const res = await filesApi.list(node.key as string);
      const dirs = res.items.filter((i) => i.type === 'dir');
      return dirs.map((d: FileItem) => ({ key: d.id, title: d.name, isLeaf: false, children: [] }));
    } catch (e) {
      message.error((e as Error).message);
      return [];
    }
  };

  const onLoadData = async (node: TreeNode): Promise<void> => {
    const children = await loadChildren(node);
    setTreeData((prev) => updateTree(prev, node.key as string, children));
  };

  const updateTree = (nodes: TreeNode[], key: string, children: TreeNode[]): TreeNode[] =>
    nodes.map((n) => {
      if (n.key === key) return { ...n, children };
      if (n.children) return { ...n, children: updateTree(n.children, key, children) };
      return n;
    });

  const handleConfirm = (): void => {
    if (!selected || confirming) return;
    setConfirming(true);
    void onConfirm(selected).finally(() => setConfirming(false));
  };

  return (
    <Modal
      open={open}
      onCancel={confirming ? undefined : onCancel}
      title={mode === 'move' ? '移动到…' : '复制到…'}
      footer={
        <Space>
          <Button onClick={onCancel} disabled={confirming}>取消</Button>
          <Button type="primary" disabled={!selected || confirming} loading={confirming} onClick={() => handleConfirm()}>
            {confirming ? '处理中…' : '确定'}
          </Button>
        </Space>
      }
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        选择目标文件夹（仅显示可浏览目录）
      </Typography.Paragraph>
      <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 4, padding: 8 }}>
        <Tree
          showIcon
          icon={<FolderOutlined style={{ color: '#faad14' }} />}
          treeData={treeData}
          loadData={(n) => onLoadData(n as TreeNode)}
          onSelect={(keys) => setSelected(keys[0] as string)}
          selectedKeys={selected ? [selected] : []}
        />
      </div>
    </Modal>
  );
}
