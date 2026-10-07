import '../src/infra/load-env';
import {
  buildContainer,
  seedApplications,
  seedUsers,
} from '../src/infra/bootstrap';

const c = buildContainer();
seedUsers(c);
const ids = await seedApplications(c);
console.log(
  `Seeded users (loan.officer, credit.officer, senior.officer) and applications: ${ids.join(', ')}`,
);
