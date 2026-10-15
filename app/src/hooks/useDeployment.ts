import { useChainData } from '../context/useChainData';
import type { ResolvedDeployment } from '../config';

export type DeploymentState = {
    deployment: ResolvedDeployment | null;
    loading: boolean;
    error: string | null;
};

export function useDeployment(): DeploymentState {
    const { deployment, deploymentLoading } = useChainData();
    return {
        deployment,
        loading: deploymentLoading,
        error: deploymentLoading
            ? null
            : deployment
                ? null
                : 'Failed to load deployment',
    };
}
