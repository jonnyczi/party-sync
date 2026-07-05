import { useLocalSearchParams } from 'expo-router';

import { JobForm } from '@/components/job-form';

export default function EditJobScreen() {
  const { id: idParam } = useLocalSearchParams<{ id: string }>();
  return <JobForm jobId={Number(idParam)} />;
}
